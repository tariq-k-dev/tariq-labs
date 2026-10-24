# tariq-labs

Data products where **the visitor's browser is the compute engine** and the origin serves
only bytes. Static front end, partitioned Parquet in object storage, no server-side query
work at all.

Three products share one data platform — which is the point: one pipeline, several
deliverables.

| App | What it is | URL | Status |
|---|---|---|---|
| `apps/querylens` | Ten questions over partitioned Parquet, answered in the browser with a per-query latency and bytes-read budget | querylens.tariqkhan.dev | **runs locally against the mock store**; not yet on R2 |
| `apps/tender-radar` | Grounded RAG over public tenders, with a published eval scorecard | tender-radar.tariqkhan.dev | not started |
| `apps/flight-atlas` | GPU-instanced 3D explorer over the same Parquet substrate | flight-atlas.tariqkhan.dev | not started |

Querylens is deliberately **not** "SQL in the browser". It ships a JavaScript Parquet
reader and ten named aggregations; the SQL route was measured and rejected (probes F/G in
[`docs/spike-r2-range.md`](docs/spike-r2-range.md)). What it does demonstrate is column
pruning over HTTP range requests, measured per query:

| | Cold, 3 of 24 partitions | Warm (all ten, one visit) |
|---|---|---|
| transfer per question | 1.69 – 2.93 MiB (3.7 – 6.4% of the corpus) | 6.42 MiB for all ten |
| engine time | 67 – 146 ms over 540,000 rows | 26 – 91 ms per question (browser HUD) |
| data requests | 100% `206 Partial Content`, zero full-object `200` | same |

Details and the full table: [`apps/querylens/README.md`](apps/querylens/README.md).

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
packages/       data-core (Parquet schema, reader helpers), eval (golden set, scorer)
pipelines/      ingestion: public data -> partitioned Parquet -> R2 (Python, UV, Polars)
spikes/         throwaway experiments that answer one risky question before building
docs/           spike records and design notes
```

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
uv run python bts/generate_sample.py     # synthetic, BTS-shaped; not real flight data

# terminal 1: the object store (mock R2 with a request log)
cd .. && node spikes/r2-range/server/range-server.mjs --port 8788

# terminal 2: the app
cd apps/querylens && pnpm dev            # http://127.0.0.1:5273
```

To reproduce the numbers above, with the mock store running:

```bash
cd apps/querylens
pnpm verify:live --cold          # per-question cost over the default 3-partition scope
pnpm verify:live --cold --all    # same over all 24 partitions
pnpm precompute                  # rebuild the static posters in public/fallback
```

All data fixtures are **synthetic** — generated deterministically, shaped like the real
public datasets, including the delay effects (carrier, hub congestion, time of day,
weekday, weather shocks) that make the questions answerable. They are marked
`"synthetic": true` in each manifest and are never presented as real data.

## License

MIT © 2026 Tariq Khan
