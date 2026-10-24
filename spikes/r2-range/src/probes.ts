/**
 * The four probes.
 *
 * Each probe answers a specific question and returns a plain object, so results
 * can be rendered as a table and pasted straight into docs/spike-r2-range.md.
 *
 *   A - transport:      does a ranged GET return 206 with Content-Range?
 *   B - cost contrast:  how many bytes for a full GET vs one 16-byte range?
 *   C - engine:         can DuckDB-WASM instantiate and read Parquet over ranges?
 *   D - pruning:        does a narrow query actually transfer fewer bytes?
 */

export const DATA_BASE = 'http://127.0.0.1:8788'
export const PARTITION = 'flights/year=2024/month=01/data.parquet'
/** 30 MiB single object. Column pruning is only measurable when the file is big
 *  enough that the engine cannot cheaply buffer it whole. */
export const BIG_PARTITION = 'flights/big/data.parquet'
export const PARTITION_URL = `${DATA_BASE}/${PARTITION}`

export interface ProbeResult {
  id: string
  question: string
  verdict: 'pass' | 'fail' | 'warn'
  rows: Array<[string, string]>
}

const ms = (n: number) => `${n.toFixed(1)} ms`
const bytes = (n: number) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / 1024 / 1024).toFixed(2)} MiB`
}

/** Server-side request log. This is the source of truth for bytes served. */
export async function serverLog(): Promise<any[]> {
  const res = await fetch(`${DATA_BASE}/__log`, { cache: 'no-store' })
  return res.json()
}

export async function resetServerLog(): Promise<void> {
  await fetch(`${DATA_BASE}/__reset`, { cache: 'no-store' })
}

/** Sum of bytes actually written to the wire by the server for ranged reads. */
export function sumBytes(log: any[], filter: (e: any) => boolean = () => true): number {
  return log.filter(filter).reduce((acc, e) => acc + (e.bytes ?? 0), 0)
}

export function countBy(log: any[], key: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of log) out[e[key]] = (out[e[key]] ?? 0) + 1
  return out
}

// ---------------------------------------------------------------- Probe A + B
export async function probeTransport(): Promise<{ result: ProbeResult; totalSize: number }> {
  // HEAD first: gives us the object size the way R2 reports it.
  const head = await fetch(PARTITION_URL, { method: 'HEAD' })
  const totalSize = Number(head.headers.get('content-length') ?? 0)
  const acceptRanges = head.headers.get('accept-ranges')

  // A ranged GET. Note the preflight the browser must send first: `Range` is
  // not a CORS-safelisted request header.
  const t0 = performance.now()
  const ranged = await fetch(PARTITION_URL, { headers: { Range: 'bytes=0-15' } })
  const rangedMs = performance.now() - t0
  const rangedBody = await ranged.arrayBuffer()

  const contentRange = ranged.headers.get('content-range')
  // Compare the first 4 bytes only: the range is 16 bytes, so a whole-buffer
  // string comparison against 'PAR1' fails even when the transport is perfect.
  const magic = new TextDecoder().decode(rangedBody.slice(0, 4))

  const rows: Array<[string, string]> = [
    ['object size (HEAD)', bytes(totalSize)],
    ['accept-ranges', acceptRanges ?? '(missing)'],
    ['ranged GET status', `${ranged.status} ${ranged.statusText}`],
    ['content-range', contentRange ?? '(missing)'],
    ['bytes received', bytes(rangedBody.byteLength)],
    ['ranged GET wall time', ms(rangedMs)],
    ['parquet magic bytes', `"${magic}"`],
    ['expect 206 + "PAR1"', ranged.status === 206 && contentRange ? 'yes' : 'NO'],
  ]

  const pass =
    ranged.status === 206 && rangedBody.byteLength === 16 && magic === 'PAR1' && acceptRanges === 'bytes'

  return {
    totalSize,
    result: {
      id: 'A/B',
      question: 'Does a ranged GET return 206 with a 16-byte PAR1 header (not a 1.85 MB body)?',
      verdict: pass ? 'pass' : 'fail',
      rows,
    },
  }
}

/** Full GET, purely to show the contrast. This is what happens if Range fails. */
export async function probeFullBody(totalSize: number): Promise<ProbeResult> {
  const t0 = performance.now()
  const res = await fetch(PARTITION_URL, { cache: 'no-store' })
  const body = await res.arrayBuffer()
  const elapsed = performance.now() - t0

  return {
    id: 'B2',
    question: 'Control: what does it cost to download the WHOLE partition instead?',
    verdict: body.byteLength === totalSize ? 'pass' : 'warn',
    rows: [
      ['status', String(res.status)],
      ['bytes received', bytes(body.byteLength)],
      ['wall time', ms(elapsed)],
      ['ratio vs 16-byte range', `${Math.round(body.byteLength / 16).toLocaleString()}x`],
    ],
  }
}

// ------------------------------------------------------------------ Probe C+D
export interface EngineRun {
  label: string
  sql: string
  rowsReturned: number
  engineMs: number
  serverBytes: number
  serverRequests: number
  rangeRequests: number
}

export async function probeEngine(
  onProgress: (msg: string) => void,
): Promise<{ result: ProbeResult; runs: EngineRun[]; wasmBytes: number; bootMs: number }> {
  const duckdb = await import('@duckdb/duckdb-wasm')

  onProgress('loading duckdb-wasm bundles…')
  const bundles = duckdb.getJsDelivrBundles()
  const bundle = await duckdb.selectBundle(bundles)

  const workerUrl = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
  )
  const worker = new Worker(workerUrl)

  const bootStart = performance.now()
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker ?? null)
  const bootMs = performance.now() - bootStart

  // directIO = true is the whole experiment: read via HTTP Range instead of
  // downloading the file into memory first.
  const bigUrl = `${DATA_BASE}/${BIG_PARTITION}`
  await db.registerFileURL('flights.parquet', bigUrl, duckdb.DuckDBDataProtocol.HTTP, true)

  const conn = await db.connect()

  // Warm-up: pays the footer/metadata read once, the way a real session would.
  // Its cost is recorded separately rather than thrown away — it is usually the
  // single largest transfer in the whole session.
  onProgress('warm-up query (pays the Parquet footer read)…')
  const beforeWarm = (await serverLog()).length
  const warmStart = performance.now()
  await conn.query(`SELECT count(*) FROM 'flights.parquet'`)
  const warmMs = performance.now() - warmStart
  const afterWarm = await serverLog()
  const warmEntries = afterWarm.slice(beforeWarm)
  const warmBytes = sumBytes(warmEntries)

  const runs: EngineRun[] = []
  const plan: Array<{ label: string; sql: string }> = [
    {
      label: 'count(*) — no data columns',
      sql: `SELECT count(*) AS n FROM 'flights.parquet'`,
    },
    {
      label: 'one column (carrier)',
      sql: `SELECT carrier, count(*) AS n FROM 'flights.parquet' GROUP BY carrier ORDER BY n DESC`,
    },
    {
      label: 'two numeric columns',
      sql: `SELECT avg(dep_delay) AS avg_dep, avg(distance) AS avg_dist FROM 'flights.parquet'`,
    },
    {
      label: 'wide scan, 4 columns',
      sql: `SELECT origin, carrier, round(avg(dep_delay),1) AS d, count(*) AS n
            FROM 'flights.parquet' GROUP BY origin, carrier ORDER BY n DESC LIMIT 10`,
    },
  ]

  for (const step of plan) {
    onProgress(`querying: ${step.label}`)
    const before = (await serverLog()).length
    const t0 = performance.now()
    const table = await conn.query(step.sql)
    const engineMs = performance.now() - t0
    const log = (await serverLog()).slice(before)

    runs.push({
      label: step.label,
      sql: step.sql.replace(/\s+/g, ' ').trim(),
      rowsReturned: table.numRows,
      engineMs,
      serverBytes: sumBytes(log),
      serverRequests: log.length,
      rangeRequests: log.filter((e) => e.status === 206).length,
    })
  }

  const wasmBytes = performance
    .getEntriesByType('resource')
    .filter((e: any) => /\.wasm($|\?)/.test(e.name) || /duckdb/.test(e.name))
    .reduce((acc, e: any) => acc + (e.transferSize || e.encodedBodySize || 0), 0)

  const maxBytes = Math.max(...runs.map((r) => r.serverBytes))
  const minBytes = Math.min(...runs.map((r) => r.serverBytes))

  const result: ProbeResult = {
    id: 'C/D',
    question: 'Can DuckDB-WASM read Parquet over HTTP ranges — and does a narrow query cost less?',
    verdict: maxBytes > 0 && runs.every((r) => r.rowsReturned > 0) ? 'pass' : 'fail',
    rows: [
      ['engine boot', ms(bootMs)],
      ['wasm/engine transfer (estimated)', bytes(wasmBytes)],
      ['warm-up (footer read)', `${ms(warmMs)} · ${bytes(warmBytes)} · ${warmEntries.length} req`],
      ['server requests per query', runs.map((r) => r.serverRequests).join(' / ')],
      ['bytes per query', runs.map((r) => bytes(r.serverBytes)).join(' / ')],
      ['spread (widest ÷ narrowest)', `${(maxBytes / Math.max(minBytes, 1)).toFixed(1)}x`],
    ],
  }

  await conn.close()
  await db.terminate()

  return { result, runs, wasmBytes, bootMs }
}

// --------------------------------------------------------------- Probe E
/**
 * hyparquet: a pure-JS Parquet reader whose byte source is an *explicit* function.
 *
 * This exists because probe C/D proved DuckDB-WASM 1.32 buffers whole objects —
 * its browser bundle has no Range support at all. hyparquet asks for byte ranges
 * directly, so column pruning is measurable rather than assumed.
 */
export async function probeHyparquet(
  onProgress: (msg: string) => void,
): Promise<{ result: ProbeResult; runs: EngineRun[]; totalSize: number }> {
  const hy = await import('hyparquet')
  const hyUtils = await import('hyparquet/src/utils.js')

  const bigUrl = `${DATA_BASE}/${BIG_PARTITION}`
  const totalSize = await hyUtils.byteLengthFromUrl(bigUrl)

  onProgress('hyparquet: reading footer metadata via ranges…')
  const runs: EngineRun[] = []
  let footerBytes = 0

  const plan: Array<{ label: string; columns: string[] }> = [
    { label: 'count row groups only (metadata)', columns: [] },
    { label: 'one column (carrier)', columns: ['carrier'] },
    { label: 'two numeric columns', columns: ['dep_delay', 'distance'] },
    { label: 'four columns', columns: ['origin', 'carrier', 'dep_delay', 'distance'] },
  ]

  for (const step of plan) {
    onProgress(`hyparquet: ${step.label}`)
    const before = (await serverLog()).length

    // A fresh async buffer per query so each measurement reflects one cold read
    // of what that query actually needs (footer + chosen column chunks).
    const file = await hyUtils.asyncBufferFromUrl({ url: bigUrl, byteLength: totalSize })

    const t0 = performance.now()
    let rowsReturned = 0
    if (step.columns.length === 0) {
      const meta = await hy.parquetMetadataAsync(file)
      rowsReturned = meta.row_groups.length
    } else {
      let count = 0
      await hy.parquetRead({
        file,
        columns: step.columns,
        rowStart: 0,
        rowEnd: 200_000,
        onComplete: (data: unknown[][]) => {
          count = data.length
        },
      })
      rowsReturned = count
    }
    const engineMs = performance.now() - t0

    const log = (await serverLog()).slice(before)
    const gotBytes = sumBytes(log)
    if (step.columns.length === 0) footerBytes = gotBytes

    runs.push({
      label: step.label,
      sql: step.columns.length ? `columns=[${step.columns.join(', ')}]` : 'metadata only',
      rowsReturned,
      engineMs,
      serverBytes: gotBytes,
      serverRequests: log.length,
      rangeRequests: log.filter((e) => e.status === 206).length,
    })
  }

  const maxBytes = Math.max(...runs.map((r) => r.serverBytes))
  const minData = Math.min(...runs.slice(1).map((r) => r.serverBytes))
  const single = runs[1].serverBytes
  const four = runs[3].serverBytes

  const result: ProbeResult = {
    id: 'E',
    question: 'With explicit range requests, does reading fewer columns actually transfer fewer bytes?',
    verdict: four > single ? 'pass' : 'fail',
    rows: [
      ['object size', bytes(totalSize)],
      ['footer only (no columns)', bytes(footerBytes)],
      ['1 column / 4 columns', `${bytes(single)} / ${bytes(four)}`],
      ['widest ÷ narrowest (data cols)', `${(maxBytes / Math.max(minData, 1)).toFixed(1)}x`],
      ['range requests per query', runs.map((r) => r.rangeRequests).join(' / ')],
      ['bytes as % of whole object', `${((four / totalSize) * 100).toFixed(1)}% (4 columns, 200k rows)`],
    ],
  }

  return { result, runs, totalSize }
}
