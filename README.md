# tariq-labs

Data products where **the visitor's browser is the compute engine** and the origin serves
only bytes. Static front end, partitioned Parquet in object storage, no server-side query
work at all.

Three products share one data platform — which is the point: one pipeline, several
deliverables.

| App | What it is | URL | Status |
|---|---|---|---|
| `apps/querylens` | Ten questions over partitioned Parquet, answered in the browser with a per-query latency and bytes-read budget | querylens.tariqkhan.dev | **runs locally against the mock store, on real BTS data**; not yet on R2 |
| `apps/tender-radar` | Grounded RAG over public tenders, with a published eval scorecard | tender-radar.tariqkhan.dev | not started |
| `apps/flight-atlas` | GPU-instanced 3D explorer over the same Parquet substrate | flight-atlas.tariqkhan.dev | not started |

Querylens is deliberately **not** "SQL in the browser". It ships a JavaScript Parquet
reader and ten named aggregations; the SQL route was measured and rejected (probes F/G in
[`docs/spike-r2-range.md`](docs/spike-r2-range.md)). What it does demonstrate is column
pruning over HTTP range requests, measured per query:

| | Cold, 3 of 12 partitions | Warm (all ten, one visit) |
|---|---|---|
| corpus | 7,044,586 real BTS rows · 46.4 MiB | same |
| transfer per question | 8.3 KiB – 4.32 MiB (0.02 – 8.9% of the corpus) | 10.1 – 12.4 MiB for all ten |
| engine time | 188 – 519 ms over 1,845,381 rows | 113 – 340 ms per question |
| data requests | 100% `206 Partial Content`, zero full-object `200` | same |

Measured after two fixes that each cut cost without changing the architecture: the reader
stopped fetching 512 KiB to find a 5.6 kB footer (38.1 → 23.3 MiB cold), and partitions moved
to one row group per file, which halves the request count for 6% more bytes. Details, the
per-question table and the gate checklist:
[`apps/querylens/README.md`](apps/querylens/README.md).

## Why this architecture

PaaS free tiers cannot run a query. **Cloudflare Workers Free gives 10 ms CPU per
invocation** and 128 MB RAM, so aggregation in a Function is impossible; Render free-tier
cold starts (~50 s) make a demo look dead. Meanwhile **R2 charges zero egress**, so serving
large byte ranges to thousands of visitors costs nothing.

Push compute to the client and the marginal cost per visitor is genuinely $0.00 — and it is
defensible in an interview only because it was measured, not asserted.

## Layout

```
apps/           three Cloudflare Pages projects, one per product
packages/       data-core (range reader, aggregations, chart geometry), eval (golden set, scorer)
pipelines/      ingestion: public data -> partitioned Parquet -> R2 (Python, UV, Polars)
spikes/         throwaway experiments that answer one risky question before building
docs/           spike records and design notes
```

## Data: real, not a fixture

`pipelines/bts/fetch.py` downloads the public BTS Reporting Carrier On-Time Performance
zips and writes partitioned SNAPPY Parquet. The source is a plain static URL — no session,
no form POST, no API key:

```
https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_YYYY_M.zip
```

One archive is ~28 MB zipped / 273 MB of CSV / 602,378 rows; the projection to 13 columns is
~4.1 MiB of Parquet. The current corpus is 12 months (Sep 2024 – Aug 2025).

`generate_sample.py` still exists as a synthetic generator for tests that must not touch
the network, and its output is marked `"synthetic": true` in the manifest so the UI labels
it. The app reads that flag; it does not assume.

## The measurement that changed the design

`spikes/r2-range/` tested whether a browser can read partial Parquet byte ranges from
R2-compatible storage. Full record: [`docs/spike-r2-range.md`](docs/spike-r2-range.md).

- **Range requests work**: a 16-byte ranged GET vs a full GET of the same object — 124,865×
  smaller.
- **DuckDB-WASM 1.32 does not range-read in the browser.** It buffered an entire 31.35 MiB
  object in one `200` with no `Range` header, then served every query from memory at 0 bytes.
- **hyparquet does.** A four-column read over 200,000 rows transferred **4.44%** of that
  object across 7 ranged requests in 32.5 ms.
- **Publish SNAPPY, not ZSTD** — hyparquet has no ZSTD decoder; SNAPPY costs +2.7% in size.

## Develop

```bash
pnpm install
cd pipelines && uv sync
uv run python bts/fetch.py --months 2024-09 2025-08    # real data, ~28 MB per month
cd ..

# terminal 1: the object store (mock R2 with a request log)
node spikes/r2-range/server/range-server.mjs --port 8788

# terminal 2: the app
cd apps/querylens && pnpm dev            # http://127.0.0.1:5273
```

To reproduce the numbers above, with the mock store running:

```bash
cd apps/querylens
pnpm verify:live --cold          # per-question cost over the default 3-partition scope
pnpm verify:live --cold --all    # same over all 12 partitions
pnpm precompute                  # rebuild the static posters in public/fallback
```

## License

MIT © 2026 Tariq Khan
