/**
 * The query worker.
 *
 * Everything expensive lives here: the Parquet reader, the byte fetches, the
 * aggregation. The main thread only renders, so a 400 ms scan never drops a frame
 * or blocks a click.
 *
 * Byte accounting comes from this worker's own `RangeSource` counters — response
 * `Content-Length`, request count, cache hits. That is the only honest source for the
 * HUD: client-side resource timing under-reported the engine bundle by two orders of
 * magnitude in the spike, and a browser cache hit reports 0 bytes regardless of what
 * actually crossed the wire.
 *
 * The read/aggregate loop itself lives in `@labs/data-core` (`runQuestion`), so the
 * verification harness exercises exactly the same code path as the page.
 */

import { assertCatalogComplete, RangeSource, runQuestion } from '@labs/data-core'
import type { WorkerRequest, WorkerResponse } from '../lib/protocol'

const ctx = self as unknown as {
  postMessage(message: WorkerResponse): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
}

assertCatalogComplete()

/** Kept across questions: footer cache and slice cache live for the session. */
const sources = new Map<string, RangeSource>()
/** Partitions whose footer has already been parsed in this worker's lifetime. */
const footersParsed = new Set<string>()

function sourceFor(url: string): RangeSource {
  let source = sources.get(url)
  if (!source) {
    source = new RangeSource(url)
    sources.set(url, source)
  }
  return source
}

async function run(request: Extract<WorkerRequest, { type: 'run' }>): Promise<void> {
  const base = request.baseUrl.replace(/\/$/, '')
  const execution = await runQuestion({
    questionId: request.questionId,
    parts: request.parts.map((part) => ({
      url: `${base}/${part.path.replace(/^\//, '')}`,
      label: `${part.year}-${String(part.month).padStart(2, '0')}`,
    })),
    corpusBytes: request.corpusBytes,
    columnsTotal: request.columnsTotal,
    sourceFor,
    footersParsed,
    onProgress: (done, total, label) => {
      ctx.postMessage({
        type: 'progress',
        id: request.id,
        questionId: request.questionId,
        done,
        total,
        label,
      })
    },
  })

  ctx.postMessage({
    type: 'done',
    id: request.id,
    questionId: request.questionId,
    result: execution.result,
    metrics: execution.metrics,
  })
}

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  if (request.type === 'reset') {
    sources.clear()
    footersParsed.clear()
    return
  }
  run(request).catch((error: unknown) => {
    ctx.postMessage({
      type: 'failed',
      id: request.id,
      questionId: request.questionId,
      message: error instanceof Error ? error.message : String(error),
    })
  })
}
