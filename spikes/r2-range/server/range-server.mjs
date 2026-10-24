/**
 * A local stand-in for Cloudflare R2, for the range-request spike.
 *
 * It exists to answer one question without needing R2 credentials:
 *   "can a browser fetch PARTIAL byte ranges of a Parquet file cross-origin,
 *    and can DuckDB-WASM then query it without downloading the whole thing?"
 *
 * It deliberately mimics R2 / S3 behaviour that the real app depends on:
 *   - `Accept-Ranges: bytes` and `206 Partial Content` with `Content-Range`
 *   - `416 Range Not Satisfiable` for a bad range
 *   - CORS preflight (OPTIONS -> 204) because `Range` is not a CORS-safelisted
 *     request header, so EVERY ranged GET is preceded by a preflight
 *   - `Access-Control-Expose-Headers` for content-range/length/etag, without
 *     which the browser downloads the bytes but JS cannot read the metadata
 *
 * It also logs every request to JSONL and exposes GET /__log, so the page can
 * prove what the *server* did rather than trusting self-reported client numbers.
 *
 * Usage:  node spikes/r2-range/server/range-server.mjs [--port 8788] [--delay 0]
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat, mkdir, appendFile, readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)))

// Root that requests are served from. Mirrors the R2 bucket layout: the bucket
// root holds `flights/year=YYYY/month=MM/data.parquet`.
const ROOT = resolve(HERE, '../../../pipelines/bts/data')

const LOG_DIR = resolve(HERE, '../out')
const LOG_FILE = join(LOG_DIR, 'requests.jsonl')

const args = process.argv.slice(2)
const argv = (flag, fallback) => {
  const i = args.indexOf(flag)
  return i === -1 ? fallback : Number(args[i + 1])
}
const PORT = argv('--port', 8788)
/** Artificial latency per request, to approximate a real network. 0 = loopback. */
const DELAY_MS = argv('--delay', 0)

/**
 * Entries live in memory and are mirrored to disk.
 *
 * The disk append is async, so a client that queries and immediately reads
 * /__log can arrive before the line commits — which silently reported 0 bytes
 * per query on the first run of this spike. In-memory is authoritative.
 */
const entries = []
let nextId = 1

const MIME = {
  '.parquet': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Parse a single-range `Range` header.
 * Returns { start, end } | null (no range) | 'unsatisfiable'.
 * Multi-range requests are intentionally unsupported: Parquet readers issue a
 * single range per read, and R2 itself ignores multi-range by returning 200.
 */
function parseRange(header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return 'unsatisfiable'
  const [, rawStart, rawEnd] = m

  if (rawStart === '' && rawEnd === '') return 'unsatisfiable'

  if (rawStart === '') {
    // Suffix range: bytes=-N means the final N bytes.
    const n = Number(rawEnd)
    if (n === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }

  const start = Number(rawStart)
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

function corsHeaders(origin) {
  return {
    // Spike only. In production this becomes an explicit allow-list of the
    // project origins, e.g. https://querylens.tariqkhan.dev.
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'range, if-match, if-none-match, content-type',
    'Access-Control-Expose-Headers':
      'content-range, content-length, accept-ranges, etag, last-modified',
    'Access-Control-Max-Age': '3600',
    'Timing-Allow-Origin': origin || '*',
  }
}

function logRequest(entry) {
  // Synchronous in memory, fire-and-forget to disk. Never awaits: a log write
  // must not be able to delay a response.
  entry.id = nextId++
  entries.push(entry)
  void appendFile(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8').catch(() => {})
  return entry
}

const server = createServer(async (req, res) => {
  const started = performance.now()
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const pathname = decodeURIComponent(url.pathname)
  const origin = req.headers.origin
  const cors = corsHeaders(origin)

  const finish = (status, bytes, extra = {}) => {
    const entry = {
      at: new Date().toISOString(),
      method: req.method,
      path: pathname,
      range: req.headers.range ?? null,
      status,
      bytes: bytes ?? 0,
      ms: Number((performance.now() - started).toFixed(2)),
      ...extra,
    }
    logRequest(entry)
  }

  // --- CORS preflight. Range is not a safelisted header, so this fires before
  // every ranged GET in a real browser. ---
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'Content-Length': '0' })
    res.end()
    finish(204, 0, { preflight: true })
    return
  }

  // --- Control endpoints used by the spike page ---
  if (pathname === '/__log') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(entries))
    return
  }

  if (pathname === '/__reset') {
    entries.length = 0
    await mkdir(LOG_DIR, { recursive: true })
    await writeFile(LOG_FILE, '', 'utf8')
    res.writeHead(204, cors)
    res.end()
    return
  }

  if (pathname === '/__health') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, root: ROOT, delayMs: DELAY_MS }))
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...cors, 'Content-Length': '0' })
    res.end()
    finish(405, 0)
    return
  }

  // --- Static file with Range support ---
  // normalize + prefix check prevents ../ traversal out of ROOT.
  const target = resolve(join(ROOT, normalize(pathname)))
  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    res.writeHead(403, { ...cors, 'Content-Length': '0' })
    res.end()
    finish(403, 0)
    return
  }

  let info
  try {
    info = await stat(target)
  } catch {
    res.writeHead(404, { ...cors, 'Content-Length': '0' })
    res.end()
    finish(404, 0)
    return
  }
  if (!info.isFile()) {
    res.writeHead(404, { ...cors, 'Content-Length': '0' })
    res.end()
    finish(404, 0)
    return
  }

  const size = info.size
  const etag = `"${size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
  const base = {
    ...cors,
    'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': info.mtime.toUTCString(),
    'Cache-Control': 'no-store',
  }

  if (DELAY_MS > 0) await sleep(DELAY_MS)

  // Conditional GET: a well-behaved object store answers 304 without a body.
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, base)
    res.end()
    finish(304, 0, { conditional: true })
    return
  }

  const range = parseRange(req.headers.range, size)

  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' })
    res.end()
    finish(416, 0, { unsatisfiable: true })
    return
  }

  if (range) {
    const length = range.end - range.start + 1
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(length),
    })
    if (req.method === 'HEAD') {
      res.end()
      finish(206, 0, { head: true, rangeBytes: length })
      return
    }
    const stream = createReadStream(target, { start: range.start, end: range.end })
    stream.pipe(res)
    await new Promise((r) => stream.on('close', r))
    finish(206, length, { rangeStart: range.start, rangeEnd: range.end, totalSize: size })
    return
  }

  // No Range header: full-body 200. The spike deliberately triggers this once to
  // show the contrast — this is what would happen if CORS/Range were misconfigured.
  res.writeHead(200, { ...base, 'Content-Length': String(size) })
  if (req.method === 'HEAD') {
    res.end()
    finish(200, 0, { head: true, totalSize: size })
    return
  }
  const stream = createReadStream(target)
  stream.pipe(res)
  await new Promise((r) => stream.on('close', r))
  finish(200, size, { totalSize: size, fullBody: true })
})

await mkdir(LOG_DIR, { recursive: true })
await writeFile(LOG_FILE, '', 'utf8')

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-r2  http://127.0.0.1:${PORT}`)
  console.log(`  serving  ${ROOT}`)
  console.log(`  delay    ${DELAY_MS}ms/request`)
  console.log(`  log      GET /__log     reset  GET /__reset     health  GET /__health`)
})
