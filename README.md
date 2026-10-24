# tariq-labs

Data products where **the visitor's browser is the compute engine** and the origin serves
only bytes. Static front end, partitioned Parquet in object storage, WebAssembly on the
client, zero server-side query work.

Three products share one data platform — which is the point: one pipeline, several
deliverables.

| App | What it is | URL |
|---|---|---|
| `apps/querylens` | SQL over ~40M public flight records, with a live latency readout | querylens.tariqkhan.dev |
| `apps/tender-radar` | Grounded RAG over public tenders, with a published eval scorecard | tender-radar.tariqkhan.dev |
| `apps/flight-atlas` | GPU-instanced 3D explorer over the same Parquet substrate | flight-atlas.tariqkhan.dev |

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
cd .. && node spikes/r2-range/server/range-server.mjs --port 8788 &
cd spikes/r2-range && pnpm exec vite --port 5173
```

All data fixtures are **synthetic** — generated deterministically, shaped like the real
public datasets. They are marked `"synthetic": true` in each manifest and are never presented
as real data.

## License

MIT © 2026 Tariq Khan
