/**
 * The dataset manifest: what the pipeline publishes alongside the Parquet files.
 *
 * The app needs the partition list before it can plan a query, and it needs the
 * corpus-wide byte total to report "you read 2.8% of the dataset" honestly. Both
 * come from one small JSON object fetched once per session — not from HEAD
 * requests to every file.
 */

export interface PartitionRef {
  year: number
  month: number
  rows: number
  bytes: number
  /** Bucket-relative path, e.g. `flights/year=2024/month=01/data.parquet`. */
  path: string
}

export interface ManifestDataset {
  name: string
  source: string
  /** True for the synthetic fixture. The UI must say so; do not present it as real. */
  synthetic: boolean
  note: string
  columns: string[]
}

export interface ManifestTotals {
  files: number
  rows: number
  bytes: number
}

export interface Manifest {
  dataset: ManifestDataset
  partitions: PartitionRef[]
  totals: ManifestTotals
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

export function partitionLabel(p: Pick<PartitionRef, 'year' | 'month'>): string {
  return `${MONTH_LABELS[p.month - 1] ?? '?'} ${p.year}`
}

export function partitionKey(p: Pick<PartitionRef, 'year' | 'month'>): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}`
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Normalise whatever the pipeline wrote into the shape the app plans against. */
export function parseManifest(raw: unknown): Manifest {
  const obj = (raw ?? {}) as Record<string, unknown>
  const dataset = (obj.dataset ?? {}) as Record<string, unknown>
  const rawParts = Array.isArray(obj.partitions) ? obj.partitions : []

  const partitions: PartitionRef[] = rawParts
    .map((entry) => {
      const p = (entry ?? {}) as Record<string, unknown>
      const year = asNumber(p.year)
      const month = asNumber(p.month)
      return {
        year,
        month,
        rows: asNumber(p.rows),
        bytes: asNumber(p.bytes),
        path:
          typeof p.path === 'string'
            ? p.path
            : `flights/year=${year}/month=${String(month).padStart(2, '0')}/data.parquet`,
      }
    })
    .filter((p) => p.year > 0 && p.month >= 1 && p.month <= 12)
    .sort((a, b) => a.year - b.year || a.month - b.month)

  const totalsRaw = (obj.totals ?? {}) as Record<string, unknown>
  const rows = partitions.reduce((sum, p) => sum + p.rows, 0)
  const bytes = partitions.reduce((sum, p) => sum + p.bytes, 0)

  return {
    dataset: {
      name: typeof dataset.name === 'string' ? dataset.name : 'Untitled dataset',
      source: typeof dataset.source === 'string' ? dataset.source : '',
      synthetic: dataset.synthetic !== false,
      note: typeof dataset.note === 'string' ? dataset.note : '',
      columns: Array.isArray(dataset.columns) ? dataset.columns.map(String) : [],
    },
    partitions,
    totals: {
      files: asNumber(totalsRaw.files, partitions.length),
      rows: asNumber(totalsRaw.rows, rows),
      bytes: asNumber(totalsRaw.bytes, bytes),
    },
  }
}

export async function loadManifest(
  baseUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<Manifest> {
  const url = `${baseUrl.replace(/\/$/, '')}/manifest.json`
  const res = await fetchImpl(url, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status} ${url}`)
  return parseManifest(await res.json())
}

export function partitionUrl(baseUrl: string, partition: PartitionRef): string {
  return `${baseUrl.replace(/\/$/, '')}/${partition.path.replace(/^\//, '')}`
}
