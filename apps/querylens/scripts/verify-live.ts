/**
 * Verification harness: run the ten questions against the real HTTP path.
 *
 * This is the number the page reports, produced outside the browser. It uses the same
 * `runQuestion` from `@labs/data-core`, the same `RangeSource` accounting, and the same
 * manifest — so a discrepancy between this output and the HUD is a bug, not a
 * difference of opinion.
 *
 * Usage:
 *   node spikes/r2-range/server/range-server.mjs --port 8788      # in another shell
 *   pnpm precompute && pnpm verify:live                          # from apps/querylens
 *
 * Flags:
 *   --all        query every partition (default: the app's default 3-month scope)
 *   --base=URL   data origin (default: http://127.0.0.1:8788)
 *   --repeat     re-run the first question to show the cache effect
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fmt1,
  fmtBytes,
  fmtInt,
  fmtMs,
  loadManifest,
  partitionLabel,
  QUESTIONS,
  runQuestion,
  RangeSource,
  type QuestionMetrics,
} from '@labs/data-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '../out')

const argv = process.argv.slice(2)
const BASE = (argv.find((a) => a.startsWith('--base='))?.slice(7) ?? 'http://127.0.0.1:8788').replace(
  /\/$/,
  '',
)
const ALL = argv.includes('--all')
const REPEAT = argv.includes('--repeat')
/** Cold: a fresh session per question, i.e. what a visitor sees clicking that card first. */
const COLD = argv.includes('--cold')
const MONTHS = ALL ? Number.POSITIVE_INFINITY : 3

interface Row {
  id: string
  title: string
  metrics: QuestionMetrics
  headline: string
  pct: number
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value + ' '.repeat(width - value.length)
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value
}

async function main(): Promise<void> {
  const manifest = await loadManifest(BASE)
  const partitions =
    MONTHS >= manifest.partitions.length
      ? manifest.partitions
      : manifest.partitions.slice(manifest.partitions.length - MONTHS)

  const scope = `${partitions.length} partitions · ${partitionLabel(partitions[0])} – ${partitionLabel(
    partitions[partitions.length - 1],
  )}`
  console.log(`data origin   ${BASE}`)
  console.log(`dataset       ${manifest.dataset.name}`)
  console.log(`synthetic     ${manifest.dataset.synthetic ? 'yes — fixture, not real records' : 'no'}`)
  console.log(
    `corpus        ${fmtInt(manifest.totals.rows)} rows · ${fmtBytes(manifest.totals.bytes)} · ${manifest.totals.files} files`,
  )
  console.log(`scope         ${scope}\n`)
  console.log(
    `session       ${COLD ? 'cold — fresh footer/slice cache per question' : 'warm — one session across all questions'}\n`,
  )

  function makeSession(): {
    sourceFor: (url: string) => RangeSource
    footersParsed: Set<string>
  } {
    const sources = new Map<string, RangeSource>()
    const footersParsed = new Set<string>()
    return {
      sourceFor: (url: string) => {
        let source = sources.get(url)
        if (!source) {
          source = new RangeSource(url)
          sources.set(url, source)
        }
        return source
      },
      footersParsed,
    }
  }

  const shared = makeSession()

  const header = `${pad('question', 18)}${padLeft('transfer', 11)}${padLeft('% corpus', 10)}${padLeft(
    'requests',
    10,
  )}${padLeft('206', 6)}${padLeft('rows', 10)}${padLeft('engine', 10)}${padLeft('agg', 9)}${padLeft(
    'footer',
    8,
  )}`
  console.log(header)
  console.log('-'.repeat(header.length))

  const results: Row[] = []
  let failures = 0

  const runs = REPEAT ? [...QUESTIONS, QUESTIONS[0]] : QUESTIONS

  for (const question of runs) {
    const session = COLD ? makeSession() : shared
    const execution = await runQuestion({
      questionId: question.id,
      parts: partitions.map((partition) => ({
        url: `${BASE}/${partition.path}`,
        label: partition.path,
      })),
      corpusBytes: manifest.totals.bytes,
      columnsTotal: manifest.dataset.columns.length,
      sourceFor: session.sourceFor,
      footersParsed: session.footersParsed,
    })

    const m = execution.metrics
    const pct = (m.bytesFetched / m.corpusBytes) * 100
    console.log(
      `${pad(question.id, 18)}${padLeft(fmtBytes(m.bytesFetched), 11)}${padLeft(
        `${fmt1(pct)}%`,
        10,
      )}${padLeft(fmtInt(m.requests), 10)}${padLeft(fmtInt(m.rangedResponses), 6)}${padLeft(
        fmtInt(m.rowsRead),
        10,
      )}${padLeft(fmtMs(m.engineMs), 10)}${padLeft(fmtMs(m.aggregateMs), 9)}${padLeft(
        `${m.footerCacheHits ? 'hit' : 'fetch'}`,
        8,
      )}`,
    )

    if (m.fullBodyResponses > 0) {
      failures += 1
      console.error(`  GATE FAILED (${question.id}): ${m.fullBodyResponses} full-object response(s)`)
    }
    if (m.rangedResponses === 0 && m.bytesFetched > 0) {
      failures += 1
      console.error(`  GATE FAILED (${question.id}): bytes transferred without a 206`)
    }
    if (m.rowsRead === 0) {
      failures += 1
      console.error(`  GATE FAILED (${question.id}): read zero rows`)
    }

    results.push({
      id: question.id,
      title: question.title,
      metrics: m,
      headline: execution.result.headline,
      pct,
    })
  }

  const totalBytes = results.reduce((sum, row) => sum + row.metrics.bytesFetched, 0)
  const totalMs = results.reduce((sum, row) => sum + row.metrics.engineMs, 0)
  const maxPct = Math.max(...results.map((row) => row.pct))
  const minPct = Math.min(...results.map((row) => row.pct))
  const scopeBytes = partitions.reduce((sum, partition) => sum + partition.bytes, 0)
  const scopeRatio = (bytes: number) => (scopeBytes > 0 ? (bytes / scopeBytes) * 100 : 0)
  const worstScopeRatio = Math.max(...results.map((row) => scopeRatio(row.metrics.bytesFetched)))

  console.log('-'.repeat(header.length))
  console.log(
    `\ntotal         ${fmtBytes(totalBytes)} across ${results.length} questions · ${fmtMs(totalMs)} engine time`,
  )
  console.log(`per query     ${fmt1(minPct)}% – ${fmt1(maxPct)}% of the corpus (${fmtBytes(scopeBytes)} scope)`)
  console.log(
    `pruning       worst question read ${fmt1(worstScopeRatio)}% of the bytes its scope contains`,
  )

  // The scale-invariant claim: a question reads a fraction of the files it touches,
  // because it asks for a subset of the columns. "% of corpus" shrinks purely by
  // selecting fewer partitions, so it is not a pruning gate.
  if (worstScopeRatio > 60) {
    failures += 1
    console.error(
      `  GATE FAILED: a question read ${fmt1(worstScopeRatio)}% of its scope's bytes (> 60%)`,
    )
  }

  await mkdir(OUT_DIR, { recursive: true })
  const payload = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    scope,
    session: COLD ? 'cold' : 'warm',
    corpus: manifest.totals,
    scopeBytes,
    questions: results.map((row) => ({
      id: row.id,
      pctOfCorpus: Number(row.pct.toFixed(3)),
      pctOfScope: Number(scopeRatio(row.metrics.bytesFetched).toFixed(3)),
      ...row.metrics,
    })),
  }
  await writeFile(resolve(OUT_DIR, 'live-metrics.json'), JSON.stringify(payload, null, 2), 'utf8')
  console.log(`\nwritten to    apps/querylens/out/live-metrics.json`)

  if (failures > 0) {
    console.error(`\n${failures} gate failure(s)`)
    process.exitCode = 1
    return
  }
  console.log('\nall gates passed: every data request was a byte range')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
