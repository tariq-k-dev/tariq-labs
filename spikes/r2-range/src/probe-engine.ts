/**
 * Probe F/G — settle the engine question.
 *
 * hyparquet is a *reader*: it returns rows, no SQL. Querylens needs GROUP BY.
 * Two ways to get it:
 *
 *   (a) F  - hyparquet fetches the needed columns, aggregate in JavaScript.
 *   (b) G  - hyparquet fetches the needed columns, hand the Arrow table to
 *            DuckDB-WASM, and let SQL run against local memory only.
 *
 * Both fetch the *same* columns, so bytes on the wire must be identical. The
 * comparison is therefore entirely about client-side cost: CPU time and bundle.
 *
 * Every byte figure here comes from the mock server's request log, not from
 * client-side introspection.
 */

import {
  BIG_PARTITION,
  DATA_BASE,
  bytes,
  ms,
  serverLog,
  sumBytes,
  type ProbeResult,
} from './probes'

/** The Querylens workload, in miniature: top carriers by mean departure delay. */
const COLUMNS = ['carrier', 'dep_delay'] as const
const ROW_LIMIT = 200_000
const SQL = `
  SELECT carrier,
         round(avg(dep_delay), 2) AS mean_dep_delay,
         count(*)                 AS n
  FROM subset
  GROUP BY carrier
  ORDER BY mean_dep_delay DESC
`

export interface EngineComparison {
  result: ProbeResult
  aRows: number
  bRows: number
  topA: string[]
  topB: string[]
  agree: boolean
  fetchBytes: number
  totalSize: number
  timings: { fetchF: number; aggJ: number; fetchG: number; arrow: number; ipc: number; sql: number; boot: number }
}

type Row = unknown[]

/** Bound the read to one row group's worth of rows so this is a like-for-like test. */
async function fetchColumns(): Promise<{ rows: Row[]; bytes: number; ms: number; requests: number }> {
  const hyUtils = await import('hyparquet/src/utils.js')
  const hy = await import('hyparquet')

  const url = `${DATA_BASE}/${BIG_PARTITION}`
  const total = await hyUtils.byteLengthFromUrl(url)
  const file = await hyUtils.asyncBufferFromUrl({ url, byteLength: total })

  const before = (await serverLog()).length
  const t0 = performance.now()
  let rows: Row[] = []
  await hy.parquetRead({
    file,
    columns: [...COLUMNS],
    rowStart: 0,
    rowEnd: ROW_LIMIT,
    onComplete: (data: unknown[]) => {
      rows = data as Row[]
    },
  })
  const elapsed = performance.now() - t0

  const log = (await serverLog()).slice(before)
  return {
    rows,
    bytes: sumBytes(log),
    ms: elapsed,
    requests: log.length,
  }
}

// ------------------------------------------------------------------ (a) JS
interface Agg {
  carrier: string
  sum: number
  n: number
}

function aggregateInJs(rows: Row[]): { groups: Agg[]; ms: number } {
  const t0 = performance.now()
  const byCarrier = new Map<string, { sum: number; n: number }>()

  // Column order follows the requested `columns` array: [carrier, dep_delay].
  for (let i = 0; i < rows.length; i++) {
    const carrier = rows[i][0] as string
    const dep = rows[i][1] as number | null
    if (dep == null) continue
    let acc = byCarrier.get(carrier)
    if (acc === undefined) {
      acc = { sum: 0, n: 0 }
      byCarrier.set(carrier, acc)
    }
    acc.sum += dep
    acc.n += 1
  }

  const groups: Agg[] = []
  for (const [carrier, acc] of byCarrier) {
    groups.push({ carrier, sum: acc.sum, n: acc.n })
  }
  groups.sort((x, y) => y.sum / y.n - x.sum / x.n)
  return { groups, ms: performance.now() - t0 }
}

// ------------------------------------------------------- (b) DuckDB on local
export async function probeHybrid(): Promise<EngineComparison> {
  const duckdb = await import('@duckdb/duckdb-wasm')
  const { tableFromArrays, tableToIPC } = await import('apache-arrow')
  const hyUtils = await import('hyparquet/src/utils.js')

  // --- boot (reported separately; in the product this is amortised once) ---
  const bundles = duckdb.getJsDelivrBundles()
  const bundle = await duckdb.selectBundle(bundles)
  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
  )
  const bootT0 = performance.now()
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl))
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker ?? null)
  const boot = performance.now() - bootT0

  const totalSize = await hyUtils.byteLengthFromUrl(`${DATA_BASE}/${BIG_PARTITION}`)

  // --- F: fetch + aggregate in JS -----------------------------------------
  const f = await fetchColumns()
  const agg = aggregateInJs(f.rows)

  // --- G: fetch (again, same columns) + Arrow + DuckDB SQL -----------------
  const g = await fetchColumns()

  const arrowT0 = performance.now()
  const carriers: string[] = []
  const depDelays: (number | null)[] = []
  for (let i = 0; i < g.rows.length; i++) {
    carriers.push(g.rows[i][0] as string)
    depDelays.push(g.rows[i][1] as number | null)
  }
  const table = tableFromArrays({ carrier: carriers, dep_delay: depDelays })
  const arrow = performance.now() - arrowT0

  const conn = await db.connect()
  const ipcT0 = performance.now()
  await conn.insertArrowFromIPCStream(tableToIPC(table), { name: 'subset' })
  const ipc = performance.now() - ipcT0

  const sqlT0 = performance.now()
  const out = await conn.query(SQL)
  const sql = performance.now() - sqlT0

  const bRows = out.toArray().map((r: any) => r.toJSON() as { carrier: string; mean_dep_delay: number })
  const topB = bRows.map((r) => `${r.carrier}:${r.mean_dep_delay}`)
  const topA = agg.groups.map((r) => `${r.carrier}:${(r.sum / r.n).toFixed(2)}`)

  // Same data, same arithmetic -> both engines must agree, else one is broken.
  // Compare NUMERICALLY, not as strings: JS toFixed(2) and SQL round(...,2) round
  // binary floats differently at a .xx5 boundary (e.g. 1.005 -> "1.00" vs 1.01).
  // A string comparison reports a false failure while the engines agree.
  const split = (s: string): [string, number] => {
    const i = s.lastIndexOf(':')
    return [s.slice(0, i), Number(s.slice(i + 1))]
  }
  let maxDelta = 0
  const agree =
    topA.length === topB.length &&
    topA.every((a, i) => {
      const [ca, va] = split(a)
      const [cb, vb] = split(topB[i] ?? '')
      maxDelta = Math.max(maxDelta, Math.abs(va - vb))
      return ca === cb && Math.abs(va - vb) <= 0.02
    })

  await conn.close()
  await db.terminate()

  const totalA = f.ms + agg.ms
  const totalB = g.ms + arrow + ipc + sql
  const verdict: ProbeResult['verdict'] = agree ? 'pass' : 'fail'

  return {
    result: {
      id: 'F/G',
      question: 'Aggregate in JS, or fetch-then-DuckDB-SQL? Same bytes either way — which is cheaper?',
      verdict,
      rows: [
        ['bytes on the wire (both paths)', `${bytes(f.bytes)} (${((f.bytes / totalSize) * 100).toFixed(2)}%)`],
        ['F  fetch + JS aggregate', `${ms(totalA)}  (fetch ${ms(f.ms)}, agg ${ms(agg.ms)})`],
        ['G  fetch + Arrow + SQL', `${ms(totalB)}  (fetch ${ms(g.ms)}, arrow ${ms(arrow)}, ipc ${ms(ipc)}, sql ${ms(sql)})`],
        ['G  DuckDB boot (one-off)', ms(boot)],
        ['G  cost over F, exclusive of boot', `${totalB - totalA > 0 ? '+' : ''}${ms(totalB - totalA)}`],
        ['rows aggregated', `${f.rows.length.toLocaleString()} / ${g.rows.length.toLocaleString()}`],
        [
          'results identical',
          agree
            ? `yes — ${topA.length} carrier groups, max delta ${maxDelta.toFixed(4)}`
            : `NO — engines disagree (max delta ${maxDelta.toFixed(4)})`,
        ],
      ],
    },
    aRows: f.rows.length,
    bRows: g.rows.length,
    topA,
    topB,
    agree,
    fetchBytes: f.bytes,
    totalSize,
    timings: { fetchF: f.ms, aggJ: agg.ms, fetchG: g.ms, arrow, ipc, sql, boot },
  }
}
