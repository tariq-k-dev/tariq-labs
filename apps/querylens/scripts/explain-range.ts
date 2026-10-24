/**
 * Where a question's bytes actually go, for one partition.
 *
 * Uses the product's own `RangeSource`, so the numbers here are the numbers the HUD
 * shows. Prints every byte range requested and splits the total into "the columns the
 * question declared" versus "everything else".
 *
 *   pnpm exec tsx scripts/explain-range.ts distance-bands flights/year=2025/month=08/data.parquet
 *
 * Why this exists: `distance-bands` asks for 2 of 13 columns but read 41.6% of its
 * scope. The first guess — hyparquet coalescing neighbouring page ranges — was wrong.
 * The real cause was the footer: `parquetMetadataAsync` defaults to fetching the last
 * 512 KiB to find a 5.6 kB footer. This script is what found that, so it stays in the
 * repo and the next surprise gets measured instead of argued about.
 */

import { parquetMetadata, parquetRead, type AsyncBuffer } from 'hyparquet'
import { RangeSource, questionById, runnerFor } from '@labs/data-core'

interface LoggedRange {
  start: number
  end: number
  bytes: number
}

async function main(): Promise<void> {
  const questionId = process.argv[2] ?? 'distance-bands'
  const relative = process.argv[3] ?? 'flights/year=2025/month=08/data.parquet'
  const baseUrl = process.argv[4] ?? 'http://127.0.0.1:8788'

  const meta = questionById(questionId)
  const runner = runnerFor(questionId)
  const state = runner.create()

  const source = new RangeSource(`${baseUrl.replace(/\/$/, '')}/${relative}`)
  const size = await source.size()

  // Wrap the product's AsyncBuffer so every slice is visible here as well as counted
  // by the product's own stats.
  const inner: AsyncBuffer = await source.file()
  const log: LoggedRange[] = []
  const traced: AsyncBuffer = {
    byteLength: inner.byteLength,
    slice: async (start: number, end?: number) => {
      const stop = end ?? inner.byteLength
      const buffer = await inner.slice(start, stop)
      log.push({ start, end: stop, bytes: buffer.byteLength })
      return buffer
    },
  }

  // Measure the footer read separately: metadata() goes through RangeSource's own
  // slice, not the traced wrapper, so the trace log never sees it.
  const bytesBefore = source.stats.bytes
  const requestsBefore = source.stats.requests
  const metadata = await source.metadata()
  const footerBytes = source.stats.bytes - bytesBefore
  const footerRequests = source.stats.requests - requestsBefore

  const rows = await new Promise<readonly unknown[][]>((resolve, reject) => {
    try {
      const pending = parquetRead({
        file: traced,
        metadata,
        columns: [...meta.columns],
        onComplete: (result) => resolve(result as readonly unknown[][]),
      })
      if (pending && typeof pending.then === 'function') {
        pending.catch((error: unknown) => reject(error))
      }
    } catch (error) {
      reject(error)
    }
  })

  runner.accumulate(state, rows)
  const result = runner.finish(state)

  console.log(`question   ${questionId}   columns ${meta.columns.join(', ')}`)
  console.log(`partition  ${relative}`)
  console.log(`size       ${size.toLocaleString('en-US')} B`)
  console.log(`rows       ${rows.length.toLocaleString('en-US')}`)
  console.log(`headline   ${result.headline}\n`)

  // Split the transfer into the column chunks the question declared and everything else.
  const wanted = new Set<string>(meta.columns)
  let wantedBytes = 0
  let otherBytes = 0
  const otherByColumn = new Map<string, number>()
  for (const group of metadata.row_groups) {
    for (const chunk of group.columns) {
      const name = chunk.meta_data?.path_in_schema?.[0] ?? '?'
      const chunkBytes = Number(chunk.meta_data?.total_compressed_size ?? 0)
      if (wanted.has(name)) wantedBytes += chunkBytes
      else {
        otherBytes += chunkBytes
        otherByColumn.set(name, (otherByColumn.get(name) ?? 0) + chunkBytes)
      }
    }
  }

  const stats = source.stats
  const transferred = stats.bytes

  console.log(`transferred        ${transferred.toLocaleString('en-US').padStart(12)} B   ${((transferred / size) * 100).toFixed(1)}% of object`)
  console.log(`  requests         ${String(stats.requests).padStart(12)}      ${stats.rangedResponses} ranged, ${stats.fullBodyResponses} full-body`)
  console.log(`  cache hits       ${String(stats.cacheHits).padStart(12)}`)
  console.log(`  declared columns ${wantedBytes.toLocaleString('en-US').padStart(12)} B   ${((wantedBytes / size) * 100).toFixed(1)}%   ${[...wanted].join(', ')}`)
  console.log(`  footer bytes     ${footerBytes.toLocaleString('en-US').padStart(12)} B   ${((footerBytes / size) * 100).toFixed(1)}%   ${footerRequests} request(s), trailer + metadata`)
  const residual = transferred - wantedBytes - footerBytes
  console.log(`  residual         ${residual.toLocaleString('en-US').padStart(12)} B   ${((residual / size) * 100).toFixed(1)}%   page headers + coalesced gaps`)
  console.log(`  undeclared cols  ${otherBytes.toLocaleString('en-US').padStart(12)} B   ${((otherBytes / size) * 100).toFixed(1)}%   in the file, not transferred\n`)

  console.log('every range requested:')
  for (const r of log) {
    console.log(`  ${r.start.toString().padStart(9)} .. ${r.end.toString().padStart(9)}   ${r.bytes.toLocaleString('en-US').padStart(9)} B`)
  }

  // Prove the exact-footer path is the one in use: trailer + metadata only, ~5.7 kB.
  const trailer = await inner.slice(size - 8, size)
  const view = new DataView(trailer)
  const metadataLength = view.getUint32(0, true)
  const exact = await inner.slice(size - metadataLength - 8, size)
  const parsed = parquetMetadata(exact)
  const total = trailer.byteLength + metadataLength
  console.log(
    `\nfooter path: trailer 8 B + metadata ${metadataLength.toLocaleString('en-US')} B = ${total.toLocaleString('en-US')} B, ` +
      `${parsed.row_groups.length} row groups — not hyparquet's 512 KiB default`,
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
