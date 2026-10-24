/**
 * A byte-range source for one Parquet object, with its own accounting.
 *
 * Why not `asyncBufferFromUrl` from hyparquet? Because Querylens' entire claim is
 * "look how few bytes this cost", and that number has to be measured rather than
 * estimated. Every response's own `Content-Length` is counted here, per request,
 * along with whether the server actually honoured the range (206) or ignored it
 * and shipped the whole object (200). If a deployment ever regresses to full-body
 * responses, `fullBodyResponses` goes above zero and the HUD says so instead of
 * the product quietly lying.
 *
 * This is *not* `performance.getEntriesByType('resource')`: that reports
 * compressed sizes inconsistently, misses requests an engine makes internally,
 * and counted the wasm bundle two orders of magnitude wrong in the spike.
 */

import { parquetMetadataAsync, type AsyncBuffer, type FileMetaData } from 'hyparquet'

export interface SourceStats {
  /** HEAD requests (size discovery). Carries no body. */
  headRequests: number
  /** Bytes actually transferred for bodies. */
  bytes: number
  /** Number of GET requests issued. */
  requests: number
  rangedResponses: number
  /** Responses that ignored `Range` and returned the whole object. Must stay 0. */
  fullBodyResponses: number
  /** Slices served from the in-memory cache instead of the network. */
  cacheHits: number
  cacheBytesServed: number
  errors: number
}

export function emptyStats(): SourceStats {
  return {
    headRequests: 0,
    bytes: 0,
    requests: 0,
    rangedResponses: 0,
    fullBodyResponses: 0,
    cacheHits: 0,
    cacheBytesServed: 0,
    errors: 0,
  }
}

export function addStats(target: SourceStats, delta: SourceStats): void {
  target.headRequests += delta.headRequests
  target.bytes += delta.bytes
  target.requests += delta.requests
  target.rangedResponses += delta.rangedResponses
  target.fullBodyResponses += delta.fullBodyResponses
  target.cacheHits += delta.cacheHits
  target.cacheBytesServed += delta.cacheBytesServed
  target.errors += delta.errors
}

export function diffStats(after: SourceStats, before: SourceStats): SourceStats {
  return {
    headRequests: after.headRequests - before.headRequests,
    bytes: after.bytes - before.bytes,
    requests: after.requests - before.requests,
    rangedResponses: after.rangedResponses - before.rangedResponses,
    fullBodyResponses: after.fullBodyResponses - before.fullBodyResponses,
    cacheHits: after.cacheHits - before.cacheHits,
    cacheBytesServed: after.cacheBytesServed - before.cacheBytesServed,
    errors: after.errors - before.errors,
  }
}

export interface RangeSourceOptions {
  /** Cap on cached slice bytes. FOOTERS AND COLUMN CHUNKS ONLY — never whole files. */
  maxCacheBytes?: number
  fetchImpl?: typeof globalThis.fetch
}

const DEFAULT_CACHE_BYTES = 48 * 1024 * 1024

export class RangeSource {
  readonly url: string
  readonly stats: SourceStats = emptyStats()

  private readonly fetchImpl: typeof globalThis.fetch
  private readonly maxCacheBytes: number
  private readonly cache = new Map<string, ArrayBuffer>()
  private cacheBytes = 0
  private sizePromise: Promise<number> | null = null
  private filePromise: Promise<AsyncBuffer> | null = null
  private metaPromise: Promise<FileMetaData> | null = null
  private totalSize = 0

  constructor(url: string, options: RangeSourceOptions = {}) {
    this.url = url
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_CACHE_BYTES
  }

  /** Object size, via HEAD. Cached for the session. */
  size(): Promise<number> {
    this.sizePromise ??= this.discoverSize()
    return this.sizePromise
  }

  private async discoverSize(): Promise<number> {
    this.stats.headRequests += 1
    const res = await this.fetchImpl(this.url, { method: 'HEAD' })
    const len = Number(res.headers.get('content-length'))
    if (res.ok && Number.isFinite(len) && len > 0) {
      this.totalSize = len
      return len
    }
    // Some signed URLs reject HEAD (403) — fall back to a one-byte ranged GET and
    // read the total out of `Content-Range: bytes 0-0/12345`.
    const probe = await this.fetchImpl(this.url, { headers: { Range: 'bytes=0-0' } })
    const contentRange = probe.headers.get('content-range') ?? ''
    const total = Number(contentRange.split('/')[1])
    await probe.arrayBuffer().catch(() => undefined)
    if (!Number.isFinite(total) || total <= 0) {
      this.stats.errors += 1
      throw new Error(`cannot determine object size: ${this.url} (${res.status})`)
    }
    this.totalSize = total
    return total
  }

  /** hyparquet's file abstraction. `slice(start, end)` is end-exclusive. */
  async file(): Promise<AsyncBuffer> {
    this.filePromise ??= this.size().then((byteLength) => ({
      byteLength,
      slice: (start: number, end?: number) => this.slice(start, end),
    }))
    return this.filePromise
  }

  private async slice(start: number, end?: number): Promise<ArrayBuffer> {
    const size = this.totalSize || (await this.size())
    const stop = Math.min(end ?? size, size)
    const from = Math.max(0, Math.min(start, size))
    if (stop <= from) return new ArrayBuffer(0)

    const key = `${from}-${stop}`
    const cached = this.cache.get(key)
    if (cached) {
      this.stats.cacheHits += 1
      this.stats.cacheBytesServed += cached.byteLength
      return cached
    }

    this.stats.requests += 1
    const res = await this.fetchImpl(this.url, {
      headers: { Range: `bytes=${from}-${stop - 1}` },
    })
    if (!res.ok) {
      this.stats.errors += 1
      throw new Error(`range fetch failed: ${res.status} ${from}-${stop - 1} ${this.url}`)
    }
    const body = await res.arrayBuffer()
    this.stats.bytes += body.byteLength

    let window: ArrayBuffer
    if (res.status === 206) {
      this.stats.rangedResponses += 1
      window = body
    } else {
      // The server ignored Range and sent the entire object. Keep the contract
      // (return only the requested window) but record the violation: this is the
      // failure mode that turns a 2.8% query into a 100% download.
      this.stats.fullBodyResponses += 1
      window = body.slice(from, stop)
    }

    this.remember(key, window)
    return window
  }

  private remember(key: string, buffer: ArrayBuffer): void {
    if (buffer.byteLength === 0 || buffer.byteLength > this.maxCacheBytes) return
    while (this.cacheBytes + buffer.byteLength > this.maxCacheBytes && this.cache.size > 0) {
      const oldest = this.cache.keys().next()
      if (oldest.done) break
      const evicted = this.cache.get(oldest.value)
      this.cache.delete(oldest.value)
      this.cacheBytes -= evicted?.byteLength ?? 0
    }
    this.cache.set(key, buffer)
    this.cacheBytes += buffer.byteLength
  }

  /**
   * Parsed footer. Cached per object for the session — the spike measured the
   * footer at 512 KiB, which was 85% of a one-column query, so re-fetching it
   * per question would dominate everything.
   */
  metadata(): Promise<FileMetaData> {
    this.metaPromise ??= this.file().then((file) => parquetMetadataAsync(file))
    return this.metaPromise
  }

  /** Row count straight from the footer, no data pages read. */
  async rowCount(): Promise<number> {
    const meta = await this.metadata()
    return meta.row_groups.reduce((sum, rg) => sum + Number(rg.num_rows), 0)
  }
}
