/**
 * One question, executed end to end: read its columns from each partition over HTTP
 * range requests, aggregate, and report what it cost.
 *
 * This lives in `data-core` rather than in the worker because two callers must agree
 * exactly: the Web Worker in the app, and the verification harness
 * (`apps/querylens/scripts/verify-live.ts`) that proves the numbers on the page. If the
 * harness had its own copy of this loop, a passing harness would prove nothing about
 * the product.
 */

import { parquetRead, type AsyncBuffer, type FileMetaData } from 'hyparquet'
import { questionById } from './catalog.js'
import { runnerFor, type Row } from './questions.js'
import { diffStats, RangeSource, type SourceStats } from './source.js'
import type { QuestionResult } from './types.js'

export interface QuestionMetrics {
  files: number
  rowsRead: number
  columnsRead: number
  columnsTotal: number
  /** Bytes actually transferred, counted from response Content-Length per request. */
  bytesFetched: number
  /** Bytes served from the in-memory slice cache instead of the network. */
  bytesFromCache: number
  requests: number
  rangedResponses: number
  /** Must stay 0: a non-zero count means the origin ignored Range. */
  fullBodyResponses: number
  fetchParseMs: number
  aggregateMs: number
  engineMs: number
  corpusBytes: number
  footerCacheHits: number
}

export interface QuestionRun {
  result: QuestionResult
  metrics: QuestionMetrics
}

export interface RunPartition {
  url: string
  /** Short label for progress reporting, e.g. `2025-03`. */
  label: string
}

export interface RunQuestionOptions {
  questionId: string
  parts: readonly RunPartition[]
  corpusBytes: number
  columnsTotal: number
  /**
   * Source factory. The app passes one backed by a session-wide cache, so the footer
   * and column-chunk slices survive between questions; the harness passes the default.
   */
  sourceFor?: (url: string) => RangeSource
  /** URLs whose footer has already been parsed in this session. */
  footersParsed?: Set<string>
  onProgress?: (done: number, total: number, label: string) => void
}

function readColumns(
  file: AsyncBuffer,
  metadata: FileMetaData,
  columns: readonly string[],
): Promise<readonly Row[]> {
  return new Promise((resolve, reject) => {
    try {
      const pending = parquetRead({
        file,
        metadata,
        columns: [...columns],
        onComplete: (rows) => resolve(rows as readonly Row[]),
      })
      // parquetRead both resolves a promise and calls onComplete; surface rejections.
      if (pending && typeof pending.then === 'function') {
        pending.catch((error: unknown) => reject(error))
      }
    } catch (error) {
      reject(error)
    }
  })
}

export async function runQuestion(options: RunQuestionOptions): Promise<QuestionRun> {
  const meta = questionById(options.questionId)
  const runner = runnerFor(options.questionId)
  const state = runner.create()
  const sourceFor = options.sourceFor ?? ((url: string) => new RangeSource(url))
  const footersParsed = options.footersParsed ?? new Set<string>()

  const totals: SourceStats = {
    headRequests: 0,
    bytes: 0,
    requests: 0,
    rangedResponses: 0,
    fullBodyResponses: 0,
    cacheHits: 0,
    cacheBytesServed: 0,
    errors: 0,
  }
  let rowsRead = 0
  let fetchParseMs = 0
  let aggregateMs = 0
  let footerCacheHits = 0
  const started = performance.now()

  for (let i = 0; i < options.parts.length; i++) {
    const part = options.parts[i]
    options.onProgress?.(i, options.parts.length, part.label)

    const source = sourceFor(part.url)
    const before: SourceStats = { ...source.stats }

    const t0 = performance.now()
    if (footersParsed.has(part.url)) footerCacheHits += 1
    const [file, metadata] = await Promise.all([source.file(), source.metadata()])
    const rows = await readColumns(file, metadata, meta.columns)
    fetchParseMs += performance.now() - t0
    footersParsed.add(part.url)

    const t1 = performance.now()
    runner.accumulate(state, rows)
    aggregateMs += performance.now() - t1
    rowsRead += rows.length

    const delta = diffStats(source.stats, before)
    totals.headRequests += delta.headRequests
    totals.bytes += delta.bytes
    totals.requests += delta.requests
    totals.rangedResponses += delta.rangedResponses
    totals.fullBodyResponses += delta.fullBodyResponses
    totals.cacheHits += delta.cacheHits
    totals.cacheBytesServed += delta.cacheBytesServed
    totals.errors += delta.errors
  }

  options.onProgress?.(options.parts.length, options.parts.length, 'aggregating')
  const tFinish = performance.now()
  const result = runner.finish(state)
  aggregateMs += performance.now() - tFinish

  return {
    result,
    metrics: {
      files: options.parts.length,
      rowsRead,
      columnsRead: meta.columns.length,
      columnsTotal: options.columnsTotal,
      bytesFetched: totals.bytes,
      bytesFromCache: totals.cacheBytesServed,
      requests: totals.requests,
      rangedResponses: totals.rangedResponses,
      fullBodyResponses: totals.fullBodyResponses,
      fetchParseMs,
      aggregateMs,
      engineMs: performance.now() - started,
      corpusBytes: options.corpusBytes,
      footerCacheHits,
    },
  }
}
