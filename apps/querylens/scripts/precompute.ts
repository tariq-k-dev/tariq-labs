/**
 * Build-time precompute for the static fallback.
 *
 * Two reasons this exists:
 *   1. `prefers-reduced-motion: reduce` must not require a live query, and neither must
 *      a visitor with JavaScript disabled (see the <noscript> block in index.html).
 *   2. It is an independent check on the aggregation code: it runs the *same* runners
 *      from `@labs/data-core` over the files on disk, with no worker, no fetch and no
 *      Parquet-over-HTTP. If the poster and the live page disagree, one of them is buggy.
 *
 * It reads whole files from the local fixture, so the numbers it prints are timings of
 * local disk reads — NOT the bytes-over-the-wire measurements the HUD reports. Do not
 * present these as transfer numbers.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parquetRead, type AsyncBuffer } from 'hyparquet'
import {
  barGeometry,
  fmt1,
  fmtBytes,
  fmtCompact,
  lineGeometry,
  parseManifest,
  QUESTIONS,
  runnerFor,
  type Geometry,
  type QuestionMeta,
  type QuestionResult,
} from '@labs/data-core'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = resolve(HERE, '../../../pipelines/bts/data')
const OUT_DIR = resolve(HERE, '../public/fallback')

const PAINT = {
  bg: '#0b0d12',
  panel: '#11141b',
  border: '#242b3a',
  text: '#e7e9ef',
  muted: '#8b93a7',
  faint: '#5b6376',
  accent: '#5eead4',
  bar: '#2c3247',
  grid: '#1b212e',
}

const WIDTH = 760
const CHART_HEIGHT = 240
const HEADER = 118

/** A file-backed AsyncBuffer — the browser's range source without the HTTP. */
async function fileBuffer(path: string): Promise<AsyncBuffer> {
  const data = await readFile(path)
  const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  return {
    byteLength: buffer.byteLength,
    slice: async (start: number, end?: number) => buffer.slice(start, end ?? buffer.byteLength),
  }
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    if (current.length === 0) current = word
    else if ((current + ' ' + word).length <= maxChars) current += ' ' + word
    else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

function tickLabels(geo: Geometry): string {
  return geo.yTicks
    .map(
      (tick) =>
        `<line x1="${geo.plot.left}" x2="${geo.plot.right}" y1="${tick.y}" y2="${tick.y}" stroke="${PAINT.grid}" />` +
        `<text x="${geo.plot.left - 8}" y="${tick.y}" fill="${PAINT.faint}" font-family="ui-monospace,monospace" font-size="10" text-anchor="end" dy="0.32em">${esc(tick.label)}</text>`,
    )
    .join('')
}

function xLabels(geo: Geometry): string {
  return geo.xLabels
    .map(
      (label) =>
        `<text x="${label.x}" y="${geo.plot.bottom + 18}" fill="${PAINT.faint}" font-family="ui-monospace,monospace" font-size="10" text-anchor="middle">${esc(label.text)}</text>`,
    )
    .join('')
}

function chartBody(geo: Geometry): string {
  if (geo.empty) {
    return `<text x="${geo.plot.left}" y="${geo.plot.top + 20}" fill="${PAINT.muted}" font-family="ui-monospace,monospace" font-size="12">no data</text>`
  }
  const baseline = `<line x1="${geo.plot.left}" x2="${geo.plot.right}" y1="${geo.baseline}" y2="${geo.baseline}" stroke="${PAINT.border}" />`
  if (geo.kind === 'bar') {
    const bars = geo.bars
      .map(
        (bar) =>
          `<rect x="${bar.x.toFixed(2)}" y="${bar.y.toFixed(2)}" width="${bar.width.toFixed(2)}" height="${bar.height.toFixed(2)}" rx="2" fill="${bar.highlight ? PAINT.accent : PAINT.bar}"${bar.highlight ? ' opacity="0.85"' : ''} />`,
      )
      .join('')
    const values =
      geo.bars.length <= 14
        ? geo.bars
            .map(
              (bar) =>
                `<text x="${(bar.x + bar.width / 2).toFixed(2)}" y="${(bar.value >= 0 ? bar.y - 5 : bar.y + bar.height + 12).toFixed(2)}" fill="${PAINT.muted}" font-family="ui-monospace,monospace" font-size="9.5" text-anchor="middle">${esc(fmtCompact(bar.value))}</text>`,
            )
            .join('')
        : ''
    return tickLabels(geo) + baseline + bars + values + xLabels(geo)
  }
  const marker = geo.highlightPoint
    ? `<circle cx="${geo.highlightPoint.x.toFixed(2)}" cy="${geo.highlightPoint.y.toFixed(2)}" r="3.5" fill="${PAINT.bg}" stroke="${PAINT.accent}" stroke-width="2" />`
    : ''
  return `${tickLabels(geo)}${baseline}<path d="${geo.areaPath}" fill="rgba(94,234,212,0.12)" /><path d="${geo.path}" fill="none" stroke="${PAINT.accent}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />${marker}${xLabels(geo)}`
}

function posterSvg(
  meta: QuestionMeta,
  result: QuestionResult,
  geo: Geometry,
  scope: string,
): string {
  const chart = result.chart
  const chartSvg = chart
    ? `<g transform="translate(20 ${HEADER})">${chartBody(geo)}</g>`
    : ''
  const height = HEADER + (chart ? CHART_HEIGHT : 40) + 46
  const headlineLines = wrap(result.headline, 74).slice(0, 2)
  const axis = chart ? `${chart.label}${chart.unit ? ` · ${chart.unit}` : ''}` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="${esc(meta.title)}">
  <rect width="${WIDTH}" height="${height}" fill="${PAINT.bg}" />
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="10" fill="none" stroke="${PAINT.border}" />
  <text x="20" y="30" fill="${PAINT.faint}" font-family="ui-monospace,monospace" font-size="10" letter-spacing="1.4">QUERYLENS · PRECOMPUTED</text>
  <text x="20" y="56" fill="${PAINT.text}" font-family="system-ui,sans-serif" font-size="17" font-weight="600">${esc(meta.title)}</text>
  ${headlineLines
    .map(
      (line, i) =>
        `<text x="20" y="${78 + i * 18}" fill="${PAINT.accent}" font-family="system-ui,sans-serif" font-size="13">${esc(line)}</text>`,
    )
    .join('')}
  ${chartSvg}
  <text x="20" y="${height - 26}" fill="${PAINT.faint}" font-family="ui-monospace,monospace" font-size="10">${esc(axis)} · ${esc(scope)}</text>
</svg>
`
}

interface PosterMetric {
  id: string
  rows: number
  columns: number
  engineMs: number
  groups: number
  headline: string
}

async function main(): Promise<void> {
  const manifest = parseManifest(JSON.parse(await readFile(join(DATA_ROOT, 'manifest.json'), 'utf8')))
  await mkdir(OUT_DIR, { recursive: true })

  const scope = `all ${manifest.partitions.length} partitions · ${manifest.totals.rows.toLocaleString('en-US')} rows · ${fmtBytes(manifest.totals.bytes)} · synthetic fixture`
  const metrics: PosterMetric[] = []

  for (const meta of QUESTIONS) {
    const runner = runnerFor(meta.id)
    const state = runner.create()
    let rows = 0
    const started = performance.now()

    for (const partition of manifest.partitions) {
      const file = await fileBuffer(join(DATA_ROOT, partition.path))
      const rowsForFile = await new Promise<readonly unknown[][]>((resolveRows, reject) => {
        try {
          const pending = parquetRead({
            file,
            columns: [...meta.columns],
            onComplete: (result) => resolveRows(result as readonly unknown[][]),
          })
          if (pending && typeof pending.then === 'function') {
            pending.catch((error: unknown) => reject(error))
          }
        } catch (error) {
          reject(error)
        }
      })
      runner.accumulate(state, rowsForFile)
      rows += rowsForFile.length
    }

    const result = runner.finish(state)
    const engineMs = performance.now() - started
    const geo = result.chart
      ? result.chart.kind === 'line'
        ? lineGeometry(result.chart, { width: WIDTH - 40, height: CHART_HEIGHT })
        : barGeometry(result.chart, { width: WIDTH - 40, height: CHART_HEIGHT })
      : null

    if (geo) {
      await writeFile(join(OUT_DIR, `${meta.id}.svg`), posterSvg(meta, result, geo, scope), 'utf8')
    }

    metrics.push({
      id: meta.id,
      rows,
      columns: meta.columns.length,
      engineMs: Number(engineMs.toFixed(1)),
      groups: result.table.rows.length,
      headline: result.headline,
    })
    console.log(
      `${meta.id.padEnd(18)} ${fmt1(engineMs).padStart(7)} ms · ${rows.toLocaleString('en-US').padStart(9)} rows · ${meta.columns.length} cols · ${result.headline}`,
    )
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    note: 'Timings are local disk reads at build time (no network). The live page reports transfer bytes from HTTP range responses instead.',
    scope,
    corpusBytes: manifest.totals.bytes,
    corpusRows: manifest.totals.rows,
    questions: metrics,
  }
  await writeFile(join(OUT_DIR, 'metrics.json'), JSON.stringify(payload, null, 2), 'utf8')
  console.log(`\n${QUESTIONS.length} posters + metrics.json -> ${OUT_DIR}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
