# Spike: R2 range requests + browser-side Parquet reading

Date: 2026-10-24
Status: **Complete — one finding invalidates the original engine choice**
Spike location: `spikes/r2-range/`
Data: synthetic, BTS-shaped (see `pipelines/bts/generate_sample.py`). Not real flight data.

---

## The question

The whole Querylens / Flight Atlas architecture rests on one assumption:

> A visitor's browser can read **partial byte ranges** of a Parquet file from
> R2-compatible object storage, and query it **without downloading the whole file**.

If that is false, the design collapses into "download 400 MB per visitor", which is worse
than the naive-CSV approach it was meant to beat. Failing fast was the point.

---

## Answer, in one line

**Range requests work. Column pruning works. DuckDB-WASM cannot be the transport (its browser
build buffers entire objects) and should not be the query engine either — `hyparquet` plus
JavaScript aggregation is 5.7× faster and 100× smaller to download.**

→ **Decision: `hyparquet` + JS aggregation. No second engine.**

---

## Method

A mock object store (`spikes/r2-range/server/range-server.mjs`) serves Parquet from
`pipelines/bts/data/` and mimics the S3/R2 behaviours this design depends on:

- `Accept-Ranges: bytes`, `206 Partial Content`, `Content-Range`
- `416` for unsatisfiable ranges, suffix ranges (`bytes=-N`)
- CORS preflight (`Range` is **not** a safelisted request header, so every ranged GET is
  preceded by an `OPTIONS`)
- `Access-Control-Expose-Headers` for `content-range`/`content-length`/`accept-ranges`/`etag`

It logs **every request with the bytes actually written to the wire**, in memory, and exposes
`GET /__log`. The page on `:5173` and the bytes on `:8788` are deliberately **different
origins** — a same-origin Vite proxy would hide the exact class of bug being tested.

All byte counts below are **server-side**, not `performance.getEntriesByType('resource')`.
The version of that used in the first run was wrong in two independent ways (see
§Instrumentation failures).

### Fixtures

| Fixture | Rows | Columns | Bytes | Compression |
|---|---|---|---|---|
| `flights/year=2024/month=01/data.parquet` | 180,000 | 13 | 1,997,846 (1.91 MiB) | SNAPPY |
| `flights/big/data.parquet` | 3,000,000 | 13 | 32,870,892 (31.35 MiB) | SNAPPY |
| Full corpus | 4,320,000 | 13 | 45.7 MiB across 24 files | SNAPPY |

---

## Results

### A — transport: PASS

| Measurement | Value |
|---|---|
| `HEAD` | `200`, `Accept-Ranges: bytes`, size 1,997,846 |
| `Range: bytes=0-15` | **`206 Partial Content`**, `Content-Range: bytes 0-15/1997846` |
| bytes received | **16** (magic bytes `PAR1`) |
| wall time | 1.2 ms |
| `OPTIONS` preflight | `204` + `Access-Control-Expose-Headers` |
| `Range: bytes=999999999-` | `416` |
| Control: full GET | 1,997,846 B — **124,865×** the ranged read |

Cross-origin partial reads work, with the preflight that `Range` forces.

### C/D — DuckDB-WASM 1.32: FAIL

```
engine boot                338.6 ms
warm-up (footer read)      262.5 ms · 31.35 MiB · 1 req
server requests per query  0 / 0 / 0 / 0
bytes per query            0 B / 0 B / 0 B / 0 B
```

The first query issued a single `GET 200` with **no `Range` header** and pulled the entire
31.35 MiB object. All four subsequent queries then cost **zero bytes** because the data was
already in memory. They ran correctly and fast (11.4 / 38.3 / 36.9 / 66.8 ms) — but on a
full local copy, not on ranges.

**Verified at the bundle level, not inferred:** the installed
`@duckdb/duckdb-wasm@1.32.0` browser bundle contains
**zero occurrences of `Range` as a request header and zero of `Content-Range`**, and the
`httpfs`/`S3` extensions are not compiled in. `DuckDBDataProtocol.HTTP` with
`directIO: true` is a **buffering** VFS in the browser. The `directIO` flag does not do what
its name and the surrounding documentation imply on this build.

Consequence had this shipped: every visitor downloads every published byte.
On a 400 MB corpus that is a 400 MB page load.

### E — hyparquet 1.31.5: PASS

Reading a bounded row range (200,000 rows) with an explicit byte-range source:

| Query | Rows | Requests | Range 206 | Bytes | % of object | Engine |
|---|---|---|---|---|---|---|
| metadata only (row-group count) | 24 groups | 1 | 1 | 524,288 | 1.59% | 5.3 ms |
| one column (`carrier`) | 200,000 | 3 | 3 | 618,316 | 1.88% | 26.9 ms |
| two numeric (`dep_delay`, `distance`) | 200,000 | 5 | 5 | 1,208,647 | 3.68% | 31.5 ms |
| four columns | 200,000 | 7 | 7 | 1,459,471 | **4.44%** | 32.5 ms |

Every data request was a `206` on a byte range — e.g. `bytes=32346604-32870891` (the footer),
`bytes=144285-191299` (47 KB column chunk). No full-body `200` was issued for data.

**Column pruning is real and measured.** A four-column read over a 31.35 MiB object transfers
1.39 MiB — **22.5× less than DuckDB-WASM's behaviour** on the same file.

---

## Three design consequences

**1. The footer looked like the dominant fixed cost — and the 512 KiB was our own bug.**
This section originally read "it is 512 KiB per file and accounts for 85% of a single-column
query". That was wrong, and it sent the product down a wrong path for two sessions.

**Corrected 2026-10-24 against the real corpus:** hyparquet's `parquetMetadataAsync` has an
`initialFetchSize` default of 512 KiB — the window it grabs because it cannot know the footer
length until it has read the trailer. The footer itself is **5,649 bytes** on these files.
Reading the 8-byte trailer first and then exactly the footer cut the ten-question cold total
from 38.1 MiB to 23.3 MiB, and one two-column question from 43.0% of its partition to 30.4%.

The cache action was right for the wrong reason: cache the parsed footer per partition, yes —
but also stop over-fetching it. Note the claim "smaller files mean smaller footers" is only
approximately true: the footer scales with column count × row-group count, not with rows, so
partitioning by time barely changes it while changing the number of files you pay it on.

**2. hyparquet has no SQL.** It is a reader: it returns rows, not aggregates. `DuckDB-WASM`
did `GROUP BY` happily (8 carrier groups, grouped averages) against buffered memory.
This is the one open architecture question and it is a genuine fork:
   - **(a) Canned aggregates only** — hyparquet returns rows, the app aggregates in JS. Simplest,
     honest, and covers a "ten canned questions" product well.
   - **(b) Hybrid** — hyparquet fetches the *needed columns only*, then hands that Arrow table
     to DuckDB-WASM for SQL, which never touches the network. Best of both: pruning from
     hyparquet, SQL from DuckDB. Most likely the right answer, needs one more probe.
   - **(c) parquet-wasm** (Rust/Arrow) — does read ranges natively. Heavier bundle, unverified.

**3. SNAPPY, not ZSTD.** hyparquet 1.31.5 ships snappy/gzip/brotli but **no ZSTD decoder** —
a ZSTD corpus fails at `decompressPage` with `parquet unsupported compression codec: ZSTD`.
Measured cost of switching on this data: **+2.7%** (30.54 → 31.35 MiB big file;
44.4 → 45.7 MiB corpus). That is a rounding error against losing client-side readability
entirely. The generator now defaults to SNAPPY.

---

## Instrumentation failures (both produced confident, wrong output)

Recorded because they are the kind of bug that makes a spike lie.

1. **The `PAR1` assertion compared a 16-byte buffer to a 4-character string.** A perfect
   206 result was reported as `FAIL`. Fixed by slicing to the first 4 bytes.
2. **The server's log was `appendFile` (async), and the client read `/__log` immediately.**
   Every per-query byte count came back `0` — which read as "the engine fetched nothing" when
   the truth was "the log line had not been flushed." Fixed by making the log authoritative
   in memory and synchronous, with the disk mirror fire-and-forget.
3. **First run used a 1.85 MiB fixture.** Too small to distinguish pruning from buffering —
   even a correct engine may buffer a file that size. Re-run against a 31.35 MiB object,
   which is what made the DuckDB finding visible.

The lesson worth keeping: **a spike's instrumentation needs its own sanity check.** Both
failures above looked like architectural findings.

---

## Probe F/G — settling the engine

`hyparquet` is a reader: it returns rows, no SQL. Querylens needs `GROUP BY`. Two options,
both fetching the **same columns** so the comparison is purely client-side cost:

| Path | What happens |
|---|---|
| **(a) F** | hyparquet fetches columns → aggregate in JavaScript |
| **(b) G** | hyparquet fetches columns → Arrow table → DuckDB-WASM SQL on local memory |

Workload: top carriers by mean departure delay (`GROUP BY carrier`, `avg(dep_delay)`,
`count(*)`) over 200,000 rows.

### Result — CPU

| | Path (a) JS | Path (b) DuckDB |
|---|---|---|
| bytes on the wire | **887.0 KiB (2.76%)** | **887.0 KiB (2.76%)** — identical, as it must be |
| fetch | 18.3 ms | 18.5 ms |
| aggregate / convert | **3.4 ms** | arrow 30.3 + ipc 38.2 + sql 36.3 = **104.8 ms** |
| **total** | **21.7 ms** | **123.3 ms** |
| one-off engine boot | 0 | 426.4 ms |
| **cost over (a)** | — | **+101.6 ms, every query** |

**The two engines agree exactly**: 8 carrier groups, max delta `0.0000`. The conversions cost
(arrow 30.3 + ipc 38.2 = 68.5 ms) is *double* what the SQL buys back (36.3 ms). Copying data
into a second engine costs more than doing the arithmetic.

### Result — download cost (the decisive number)

| Asset | Transfer |
|---|---|
| `duckdb-eh.wasm` (brotli, from jsDelivr, measured via `curl --compressed`) | **6,764,975 B = 6.45 MiB** |
| `duckdb-browser.js` | 27,407 B (7.00 kB gzip) |
| `apache-arrow` serialization chunk (IPC only) | 193,680 B (45.55 kB gzip) |
| **hyparquet JS (index + utils)** | **65,317 B (≈21 kB gzip)** |

The SQL path costs a visitor **6.45 MiB more than the reader path — roughly 100× the bytes** —
to buy 8 lines of SQL that JavaScript writes in 12 lines anyway. On a 5 Mbps connection that is
~11 seconds of download for the privilege.

### Decision

**Path (a): `hyparquet` + JavaScript aggregation.** Reasons, in order of weight:

1. 6.45 MiB vs 65 kB is not a trade-off, it is a different product. Querylens' entire premise
   is "instant, free, client-side"; a 6.45 MiB engine download breaks the premise it exists
   to demonstrate.
2. It is **faster** on the measured workload (+101.6 ms for the SQL path), so this is not
   speed-sacrificed-for-size.
3. One engine is one thing to explain in an interview.

**Accepted cost:** no SQL. Canned questions become named functions with real aggregation code.
That is a smaller, more honest product — and for Querylens the "ten canned questions with
captions" design already implied it. If a future requirement genuinely needs joins or window
functions, re-open this with a measurement, not an assumption.

**What this forbids advertising:** never describe Querylens as "SQL in the browser" now. It is
"a query engine in the browser with canned questions". Precision here matters, because the
previous claim would be a lie a technical interviewer could catch.

### Instrumentation failure #4

The first F/G run reported `results identical: NO`. The engines agreed perfectly. The check
compared strings — JS `toFixed(2)` against SQL `round(..., 2)` — which disagree at a binary
float boundary like `1.005` (`"1.00"` vs `1.01`). Comparing `Number` values with a 0.02
tolerance gave max delta `0.0000`. **Same shape as failures #1 and #2: the assertion was
wrong, the system was fine.** Any spike assertion that compares formatted output is suspect.

---

## Gates from this spike

- [x] Cross-origin ranged GET returns `206` + `Content-Range` — verified
- [x] CORS preflight and exposed headers correct — verified
- [x] `416` and suffix ranges behave — verified
- [x] A four-column read over 31 MiB transfers < 5% of the object — **4.44%**
- [x] No full-body `200` issued for any data read — verified in the request log
- [x] Engine bytes stay out of other routes — n/a in the spike, gate stands for the product
- [x] **F/G engine probe**: JS aggregation wins on both CPU and bytes — decided
- [x] Ten canned questions implemented as JS aggregations, with a caption on each — in
      `apps/querylens`, measured cold and warm
- [ ] Same measurements against the **real R2 bucket**, not the mock
- [ ] Throttled run (4x CPU / 8 Mbps) — the number that gets published next to the good one
- [x] Real BTS corpus at product scale — 12 real months, **7,044,586 rows / 46.4 MiB**
      (a 5-year window would be ~36 M rows / ~228 MiB; 12 months was chosen to keep the
      ingest loop under four minutes while the architecture is still being built)

**Superseded by real data (2026-10-24).** Every absolute figure above was measured on a
synthetic 4.32M-row fixture. The real corpus reproduces the transport findings — 100%
`206` responses, zero full-body `200`s — but not the ratios, because the real projection is
4.1 MiB per month rather than 1.9 MiB and because the footer bug described in §"Three design
consequences" inflated every narrow query. Current numbers: `apps/querylens/README.md`.

## Post-spike changes to the fixture (2026-10-24, after the measurements above)

The generator was extended *after* this spike so the ten product questions have real
answers — the original fixture drew carrier, airport, hour and weekday independently, so
every question returned "no effect", which is useless as a demo. `build_month` now applies
carrier skill, origin-hub congestion, a time-of-day accumulation ramp, day-of-week and
per-day weather shocks, plus distance-based recovery on arrival delay.

Consequences for reading this document: parquet bytes moved by **< 0.5%** (1,997,846 →
1,993,842 B per month; 45.7 → 45.6 MiB corpus), so the transport findings stand, but any
absolute byte figure quoted above belongs to the v1 fixture.

The fixture has since been replaced entirely: `pipelines/bts/fetch.py` ingests the real BTS
zips, and the synthetic generator is kept only for tests that must not touch the network.
Product-level numbers, measured through the app's own code path (`runQuestion`) rather than
this spike harness, are in `apps/querylens/README.md`.

---

## Reproduce

```bash
cd pipelines && uv sync
uv run python bts/generate_sample.py        # 24 partitions, SNAPPY, 45.7 MiB
uv run python bts/_mkbig.py                 # 31.35 MiB single object

cd .. && node spikes/r2-range/server/range-server.mjs --port 8788 &
cd spikes/r2-range && pnpm exec vite --port 5173
# open http://127.0.0.1:5173 (auto-runs), then: curl -s localhost:8788/__log
```
