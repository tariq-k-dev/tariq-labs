/**
 * Messages between the main thread and the query worker.
 *
 * The worker owns hyparquet and every byte fetch. The main thread owns the DOM and
 * never imports the Parquet reader, which is what keeps the reader out of the entry
 * bundle (an acceptance gate, checked against the build output).
 */

import type { QuestionMetrics, QuestionResult } from '@labs/data-core'

export interface PartitionPlan {
  path: string
  year: number
  month: number
  rows: number
  bytes: number
}

/** Alias, so the wire protocol and the code that measures cannot drift apart. */
export type RunMetrics = QuestionMetrics

export type WorkerRequest =
  | {
      type: 'run'
      id: string
      questionId: string
      baseUrl: string
      parts: PartitionPlan[]
      corpusBytes: number
      columnsTotal: number
    }
  | { type: 'reset' }

export type WorkerResponse =
  | { type: 'progress'; id: string; questionId: string; done: number; total: number; label: string }
  | { type: 'done'; id: string; questionId: string; result: QuestionResult; metrics: RunMetrics }
  | { type: 'failed'; id: string; questionId: string; message: string }
