# Querylens — in-browser analytics, measured per query

Ten questions over real US domestic flight data, answered **inside the visitor's browser**
by reading byte ranges out of Parquet in object storage. No query server, no database, no
WebAssembly engine. Every answer publishes its own cost: bytes transferred, requests
issued, engine milliseconds, rows read, columns touched.

This is the first of the three `tariq-labs` products. Architecture constraints and the
engine decision live in `../docs/spike-r2-range.md`; the product spec is
`D:/Dev/Portfolio/docs/project-ideas.md` §3.

## What it does, from the visitor's point of view

1. The page opens with ten questions and a partition selector (1 → 12 months).
2. Clicking a question downloads **only that question's columns** from the partitions in
   scope, over HTTP `Range` requests, inside a Web Worker.
3. The answer arrives with a chart, a table, and a latency budget strip: transfer,
   requests (206 vs 200), engine time, render time, rows, columns.
4. Nothing is fetched and no engine code is downloaded until the first click.

## The data is real

`BTS Reporting Carrier On-Time Performance`, 12 monthly partitions (Sep 2024 – Aug 2025),
**7,044,586 rows / 46.4 MiB**, projected from the 110-column source CSV to the 13 columns
these questions need. `pipelines/bts/fetch.py` downloads the public zips — a plain static
URL, no session and no API key — and writes SNAPPY Parquet. Nothing is transformed at
request time.

## Run it

```bash
# terminal 1 — the object store (mock R2 over pipelines/bts/data, with a request log)
cd D:/Dev/tariq-labs && node spikes/r2-range/server/range-server.mjs --port 8788

# terminal 2 — the app
cd D:/Dev/tariq-labs/apps/querylens
pnpm dev                      # http://127.0.0.1:5273
```

The app and the bytes are deliberately on **different origins**. A same-origin Vite proxy
would hide the CORS/preflight class of bug this architecture is most likely to break on.

Data origin is configurable: `VITE_DATA_BASE=https://data.tariqkhan.dev pnpm build`.
The corpus is gitignored; rebuild it with:

```bash
cd D:/Dev/tariq-labs/pipelines
uv sync
uv run python bts/fetch.py --months 2024-09 2025-08   # ~28 MB zip + ~4 MiB parquet per month
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | dev server on `:5273` |
| `pnpm build` | typecheck (incl. scripts) + `vite build` |
| `pnpm precompute` | runs the ten aggregations over the local corpus and writes `public/fallback/*.svg` + `metrics.json` |
| `pnpm verify:live` | runs the ten questions through the real HTTP path, prints the cost table, fails on a broken gate |
| `pnpm exec tsx scripts/explain-range.ts <question> <path>` | prints every byte range one question issues, split into declared columns vs footer vs residual |

`verify:live` flags: `--cold` (fresh footer/slice cache per question), `--all` (every
partition instead of the default three), `--repeat` (re-run the first question to show the
cache effect), `--base=URL`.

## Measured (2026-10-24, mock R2 on loopback, real BTS corpus, SNAPPY, row groups 700k)

Cold session — each question paying its own way — over the default 3-partition scope
(1,845,381 rows, 12.1 MiB of files):

| Question | Columns | Transfer | % corpus | Requests | Engine |
|---|---|---|---|---|---|
| carrier-delay | 2 | 2.32 MiB | 5.0% | 29 | 367 ms |
| airport-delay | 2 | 3.01 MiB | 6.5% | 28 | 347 ms |
| hour-of-day | 2 | 3.13 MiB | 6.7% | 24 | 324 ms |
| day-of-week | 2 | 2.42 MiB | 5.2% | 18 | 326 ms |
| cancellations | 2 | 75 KiB | 0.2% | 30 | 284 ms |
| routes | 3 | 3.86 MiB | 8.3% | 28 | 447 ms |
| distance-bands | 2 | 3.59 MiB | 7.7% | 29 | 252 ms |
| daily | 3 | 2.53 MiB | 5.4% | 40 | 373 ms |
| carrier-share | 1 | 18 KiB | 0.04% | 18 | 210 ms |
| extreme-delays | 2 | 2.32 MiB | 5.0% | 29 | 288 ms |

Total 23.3 MiB and 3.2 s of engine time for all ten, cold.

**Every data request was a `206` with a non-zero byte count. No full-object `200` was ever
issued.** Pruning: the worst question read 31.9% of the bytes its own scope contains, the
cheapest 0.05%.

Warm session — a visitor running all ten in one page visit — **10.1–12.4 MiB for all ten,
~1.9 s engine**, because footer and column-chunk slices are cached for the session. That is
why `carrier-share` and `extreme-delays` report `0 B cached` on a second pass: their two
columns were already pulled by earlier questions. The HUD shows cached bytes separately so
a cache hit is never counted as a saving.

All 12 partitions, cold: 234 KiB – 14.9 MiB per question (0.1% – 32.2% of the corpus),
0.75–1.7 s engine, 87.7 MiB total. Scope is the dominant cost term, not the query.

Build output (gzip): entry **79.7 kB**, worker (engine + aggregations) **22.9 kB**, CSS
2.5 kB. The engine is a separate chunk and is only requested after the first click.
Verified by content, not name: no `PAR1` magic, no codec error string, no SNAPPY decoder in
the entry bundle — all three are in the worker chunk.

## The footer: the single biggest fixable cost

`hyparquet`'s `parquetMetadataAsync` defaults to `initialFetchSize = 512 KiB`: it cannot
know the footer length until it has read the trailer, so it grabs the last 512 KiB and
hopes. On these partitions the footer is **5,649 bytes**, so every question paid 512 KiB
per file to find it — 92× more than needed.

`RangeSource.metadata()` now reads the 8-byte trailer first, then fetches exactly the
footer. Measured on one partition (`explain-range.ts distance-bands`):

| | before | after |
|---|---|---|
| transferred for 2 of 13 columns | 1,769,665 B (43.0%) | 1,251,042 B (30.4%) |
| declared column chunks | 1,237,593 B | 1,237,593 B |
| footer | 532,072 B | 5,665 B |
| residual (page headers, coalesced gaps) | — | 7,784 B |

And across the ten questions, cold: **38.1 → 23.3 MiB**. The bug was invisible for two
sessions because the extra bytes looked like column pruning; `scripts/explain-range.ts`
exists so the next surprise is measured rather than argued about.

This is also why the spike's "footer is 512 KiB and 85% of a one-column query" note was
wrong: 512 KiB was the fetch window, not the footer. The corrected number makes small
partitions far cheaper than the spike implied.

## Why per-file cost still matters

The `carrier` column is **401 bytes per partition** (dictionary-encoded, 15 distinct
codes), so `carrier-share` transfers 18 KiB across three partitions — almost all of it
footers. Conversely `distance` + `arr_delay` are 30% of a file's column chunks, so
`distance-bands` is the most expensive two-column question. Column choice, not column
count, sets the price.

## Gates

From `docs/project-ideas.md` §3, current status:

- [x] engine + shell transfer measured — 79.7 kB entry + 22.9 kB worker gzip, no wasm
- [x] nothing but the product loads the engine — separate worker chunk, entry bundle checked by content
- [x] cold query < 2 s — 210–447 ms per question over 1.8 M rows on the default scope
- [ ] steady-state < 100 ms — **not met cold: the ten questions run 210–447 ms.** Warm
      repeats are 113–340 ms. The engine is not the bottleneck; transfer and page decode are.
      Stated as measured, not rounded up.
- [x] ranged GETs proven — 100% `206`, zero full-body responses, every partition
- [ ] ranged read verified against the **real R2 bucket** — not yet; mock only
- [x] latency HUD shows measured values, not placeholders
- [x] static fallback + reduced-motion posters render the headline result
- [x] 10 canned questions, each with a one-line caption

## Not built yet

- The R2 bucket and one GitHub Action that runs `fetch.py` and syncs. The download URL is
  resolved and verified, so this is plumbing, not research.
- The throttled run (4× CPU / 8 Mbps). The UI says plainly that it has not been measured.
- Cloudflare Pages project + `querylens.tariqkhan.dev` + bucket CORS policy.

## Layout

```
src/
  App.tsx                 page: controls, question panel, result, query log, claims
  worker/query.worker.ts  the only place hyparquet is imported
  lib/useLens.ts          manifest, worker lifecycle, run state, render timing
  lib/protocol.ts         worker message types (metrics aliased from data-core)
  components/             QuestionList, Chart (SVG), ResultTable, Hud
scripts/
  precompute.ts           static posters + metrics.json (same runners, no HTTP)
  verify-live.ts          the measurement harness above
  explain-range.ts        per-range byte accounting for one question
public/fallback/          precomputed SVGs (committed: the deploy has no corpus)
```

`packages/data-core` holds everything reusable: `RangeSource` (byte-counting range reads,
exact footer reads, slice cache), the question catalog and aggregations, `runQuestion` (the
loop both the worker and the harness use), the manifest parser and the chart geometry.
