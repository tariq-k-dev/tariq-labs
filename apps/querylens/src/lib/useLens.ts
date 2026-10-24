import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadManifest,
  partitionLabel,
  QUESTIONS,
  type Manifest,
  type PartitionRef,
  type QuestionResult,
} from '@labs/data-core'
import type { PartitionPlan, RunMetrics, WorkerRequest, WorkerResponse } from './protocol'

/** Where the bytes live. Local mock by default; set VITE_DATA_BASE for the real bucket. */
export const DATA_BASE = (
  (import.meta.env.VITE_DATA_BASE as string | undefined) ?? 'http://127.0.0.1:8788'
).replace(/\/$/, '')

export type RangeKey = 'm1' | 'm3' | 'm6' | 'm12' | 'all'

export const RANGES: { key: RangeKey; label: string; months: number }[] = [
  { key: 'm1', label: 'latest month', months: 1 },
  { key: 'm3', label: '3 months', months: 3 },
  { key: 'm6', label: '6 months', months: 6 },
  { key: 'm12', label: '12 months', months: 12 },
  { key: 'all', label: 'all months', months: Number.POSITIVE_INFINITY },
]

export interface RunRecord {
  status: 'idle' | 'running' | 'done' | 'failed'
  result?: QuestionResult
  metrics?: RunMetrics
  /** Main-thread time from receiving the result to the next painted frame. */
  renderMs?: number
  progress?: { done: number; total: number; label: string }
  error?: string
  rangeLabel?: string
  at?: number
}

export function pickPartitions(manifest: Manifest, key: RangeKey): PartitionRef[] {
  const months = RANGES.find((r) => r.key === key)?.months ?? 1
  const all = manifest.partitions
  if (months >= all.length) return all
  return all.slice(Math.max(0, all.length - months))
}

export function rangeLabelOf(key: RangeKey): string {
  return RANGES.find((r) => r.key === key)?.label ?? key
}

function toPlan(partition: PartitionRef): PartitionPlan {
  return {
    path: partition.path,
    year: partition.year,
    month: partition.month,
    rows: partition.rows,
    bytes: partition.bytes,
  }
}

export interface LensState {
  manifest: Manifest | null
  manifestError: string | null
  range: RangeKey
  setRange: (key: RangeKey) => void
  partitions: PartitionRef[]
  rangeSummary: string
  runs: Record<string, RunRecord>
  runOne: (questionId: string) => Promise<void>
  runAll: () => Promise<void>
  busy: boolean
  reset: () => void
  selected: string
  select: (id: string) => void
}

export function useLens(): LensState {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [range, setRange] = useState<RangeKey>('m3')
  const [runs, setRuns] = useState<Record<string, RunRecord>>({})
  const [selected, setSelected] = useState<string>(QUESTIONS[0].id)

  const workerRef = useRef<Worker | null>(null)
  const pending = useRef(new Map<string, () => void>())
  const manifestRef = useRef<Manifest | null>(null)
  const rangeRef = useRef<RangeKey>(range)
  rangeRef.current = range

  useEffect(() => {
    let cancelled = false
    loadManifest(DATA_BASE)
      .then((loaded) => {
        if (cancelled) return
        manifestRef.current = loaded
        setManifest(loaded)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setManifestError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** The worker — and therefore the Parquet reader — is created on first run, never on load. */
  const ensureWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current
    const worker = new Worker(new URL('../worker/query.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      if (message.type === 'progress') {
        setRuns((prev) => {
          const current = prev[message.questionId]
          if (!current || current.status !== 'running') return prev
          return {
            ...prev,
            [message.questionId]: {
              ...current,
              progress: { done: message.done, total: message.total, label: message.label },
            },
          }
        })
        return
      }

      if (message.type === 'failed') {
        setRuns((prev) => ({
          ...prev,
          [message.questionId]: { status: 'failed', error: message.message, at: Date.now() },
        }))
        pending.current.get(message.id)?.()
        pending.current.delete(message.id)
        return
      }

      // done: record the metrics immediately, then measure the paint that follows.
      const receivedAt = performance.now()
      setRuns((prev) => ({
        ...prev,
        [message.questionId]: {
          status: 'done',
          result: message.result,
          metrics: message.metrics,
          rangeLabel: rangeLabelOf(rangeRef.current),
          at: Date.now(),
        },
      }))
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const renderMs = performance.now() - receivedAt
          setRuns((prev) => {
            const current = prev[message.questionId]
            if (!current || current.status !== 'done') return prev
            return { ...prev, [message.questionId]: { ...current, renderMs } }
          })
          pending.current.get(message.id)?.()
          pending.current.delete(message.id)
        })
      })
    }
    workerRef.current = worker
    return worker
  }, [])

  const runOne = useCallback(
    (questionId: string): Promise<void> =>
      new Promise<void>((resolve) => {
        const current = manifestRef.current
        if (!current) {
          resolve()
          return
        }
        const parts = pickPartitions(current, rangeRef.current)
        const id = `${questionId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
        pending.current.set(id, resolve)
        setRuns((prev) => ({
          ...prev,
          [questionId]: {
            status: 'running',
            progress: { done: 0, total: parts.length, label: 'planning' },
            rangeLabel: rangeLabelOf(rangeRef.current),
          },
        }))
        const request: WorkerRequest = {
          type: 'run',
          id,
          questionId,
          baseUrl: DATA_BASE,
          parts: parts.map(toPlan),
          corpusBytes: current.totals.bytes,
          columnsTotal: current.dataset.columns.length || 13,
        }
        ensureWorker().postMessage(request)
      }),
    [ensureWorker],
  )

  const runAll = useCallback(async () => {
    for (const question of QUESTIONS) {
      await runOne(question.id)
    }
  }, [runOne])

  const reset = useCallback(() => {
    workerRef.current?.postMessage({ type: 'reset' } satisfies WorkerRequest)
    setRuns({})
  }, [])

  const partitions = manifest ? pickPartitions(manifest, range) : []
  const rangeSummary = partitions.length
    ? `${partitions.length} partition${partitions.length === 1 ? '' : 's'} · ${
        partitions.length === 1
          ? partitionLabel(partitions[0])
          : `${partitionLabel(partitions[0])} – ${partitionLabel(partitions[partitions.length - 1])}`
      } · ${partitions.reduce((sum, p) => sum + p.rows, 0).toLocaleString('en-US')} rows`
    : 'loading dataset…'

  const busy = Object.values(runs).some((run) => run.status === 'running')

  return {
    manifest,
    manifestError,
    range,
    setRange,
    partitions,
    rangeSummary,
    runs,
    runOne,
    runAll,
    busy,
    reset,
    selected,
    select: setSelected,
  }
}
