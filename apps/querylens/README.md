# Querylens — in-browser analytics, measured per query

Ten questions over US domestic flight data, answered **inside the visitor's browser** by
reading byte ranges out of Parquet in object storage. No query server, no database, no
WebAssembly engine. Every answer publishes its own cost: bytes transferred, requests
issued, engine milliseconds, rows read, columns touched.

This is the first of the three `tariq-labs` products. Architecture constraints and the
engine decision live in `../docs/spike-r2-range.md`; the product spec is
`D:/Dev/Portfolio/docs/project-ideas.md` §3.

## What it does, from the visitor's point of view

1. The page opens with ten questions and a partition selector (1 → 24 months).
2. Clicking a question downloads **only that question's columns** from the partitions in
   scope, over HTTP `Range` requests, inside a Web Worker.
3. The answer arrives with a chart, a table, and a latency budget strip: transfer,
   requests (206 vs 200), engine time, render time, rows, columns.
4. Nothing is fetched and no engine code is downloaded until the first click.

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
The fixture itself is generated and gitignored:

```bash
cd D:/Dev/tariq-labs/pipelines && uv sync && uv run python bts/generate_sample.py
```

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | dev server on `:5273` |
| `pnpm build` | typecheck (incl. scripts) + `vite build` |
| `pnpm precompute` | runs the ten aggregations over the local fixture and writes `public/fallback/*.svg` + `metrics.json` |
| `pnpm verify:live` | runs the ten questions through the real HTTP path, prints the cost table, fails on a broken gate |

`verify:live` flags: `--cold` (fresh footer/slice cache per question), `--all` (every
partition instead of the default three), `--repeat` (re-run the first question to show the
cache effect), `--base=URL`.

## Measured (2026-10-24, mock R2 on loopback, 24-month fixture, SNAPPY)

Cold session — each question paying its own way — over the default 3-partition scope
(540,000 rows, 5.70 MiB of files):

| Question | Columns | Transfer | % corpus | Requests | Engine |
|---|---|---|---|---|---|
| carrier-delay | 2 | 2.29 MiB | 5.0% | 15 | 146 ms |
| airport-delay | 2 | 2.42 MiB | 5.3% | 15 | 119 ms |
| hour-of-day | 2 | 2.42 MiB | 5.3% | 15 | 94 ms |
| day-of-week | 2 | 2.29 MiB | 5.0% | 9 | 89 ms |
| cancellations | 2 | 1.71 MiB | 3.8% | 15 | 80 ms |
| routes | 3 | 2.74 MiB | 6.0% | 15 | 146 ms |
| distance-bands | 2 | 2.93 MiB | 6.4% | 15 | 94 ms |
| daily | 3 | 2.72 MiB | 6.0% | 21 | 132 ms |
| carrier-share | 1 | 1.69 MiB | 3.7% | 9 | 67 ms |
| extreme-delays | 2 | 2.29 MiB | 5.0% | 15 | 89 ms |

**Every data request was a `206` with a non-zero byte count. No full-object `200` was ever
issued.** Pruning is real: the worst question read 51.3% of the bytes its own scope
contains; the cheapest read 29.6%.

Warm session (a visitor running all ten in one page visit, in the browser): **6.43 MiB and
489 ms of engine time for all ten**, because the footer and column-chunk slices are cached
per session. The first question pays; the rest are close to free.

All 24 partitions, cold: 29.6%–51.2% of the corpus per question, 480–960 ms engine,
188.3 MiB total. Selecting scope is a product control, not a detail — it is the dominant
term in cost.

Build output (gzip): entry **78.7 kB**, worker (engine + aggregations) **22.3 kB**, CSS
2.5 kB. The engine is a separate chunk and is only requested after the first click.
Verified: no SNAPPY decoder, no `PAR1` magic, no `parquetRead` in the entry bundle.

## Why the footer dominates a narrow question

Per-file the footer is ~0.5 MiB regardless of file size, and the monthly fixture files are
~1.9 MiB. So a one-column question over three files transfers 1.69 MiB of which ~1.5 MiB
is footer. That is why `carrier-share` (1 column) costs 3.7% of the corpus while
`distance-bands` (2 columns) costs 6.4%: the fixed per-file cost is large relative to these
small files, and columns add on top. The spike measured 4.44% of a **31 MiB** object for
four columns — as files get bigger the ratio converges toward the column share. Shrinking
the partition size (weekly instead of monthly) is the lever that lowers the fixed cost.

## Gates

From `docs/project-ideas.md` §3, current status:

- [x] engine + shell transfer measured — 78.7 kB entry + 22.3 kB worker gzip, no wasm
- [x] nothing but the product loads the engine — separate worker chunk, entry bundle checked
- [x] cold query < 2 s — 67–146 ms per question over 540k rows
- [ ] steady-state < 100 ms — **7 of 10 cold questions are under 100 ms; three are 119–146 ms.**
      Warm repeats are 26–91 ms. Stated as measured, not rounded up.
- [x] ranged GETs proven — 15/15 `206` per question, zero full-body responses
- [ ] ranged read verified against the **real R2 bucket** — not yet; mock only
- [x] latency HUD shows measured values, not placeholders
- [x] static fallback + reduced-motion posters render the headline result
- [x] 10 canned questions, each with a one-line caption

## Not built yet

- Real BTS ingestion (TranStats is a form POST returning `302`; needs a resolved download
  URL before an Action can automate it) and the R2 bucket itself.
- The throttled run (4× CPU / 8 Mbps) whose number the footer promises to publish. The
  ~7× figure quoted there comes from third-party measurements and must be re-measured
  here before it is presented as ours.
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
public/fallback/          precomputed SVGs (committed: the deploy has no fixture)
```

`packages/data-core` holds everything reusable: `RangeSource` (byte-counting range reads
and the footer cache), the question catalog and aggregations, `runQuestion` (the loop both
the worker and the harness use), the manifest parser and the chart geometry.
