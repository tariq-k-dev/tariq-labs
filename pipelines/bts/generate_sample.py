"""Generate a BTS-shaped sample dataset as partitioned Parquet.

Why this exists
---------------
The R2 range-request spike needs Parquet that *looks like* the real thing (same
columns, same partition layout, same order of magnitude of bytes per column) so
the measurements transfer. It must not be the real 100M-row dataset: the spike
answers one question about transport, and a small file answers it faster.

The data is synthetic and deterministic (fixed seed per month). It is NOT real
flight data and must never be presented as such.

Usage:
    uv run python generate_sample.py --rows-per-month 180000 --months 24
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import polars as pl

# A deliberate subset of BTS On-Time Performance fields. The real dataset has
# ~110 columns; these are the ones a visitor actually queries.
CARRIERS = np.array(["AA", "DL", "UA", "WN", "B6", "AS", "NK", "F9"])
HUBS = np.array(
    [
        "ATL", "ORD", "DFW", "DEN", "LAX", "JFK", "SFO", "SEA", "MIA", "BOS",
        "EWR", "PHX", "IAH", "LAS", "MSP", "DTW", "CLT", "PHL", "SLC", "SAN",
    ]
)

# Effects below are synthetic but *shaped* like the real BTS signatures. Without them
# every question on the site answers "no effect", which is useless as a demo and
# misleading as a fixture. None of these numbers are real records.
CARRIER_DELAY = np.array([-1.8, 0.9, 0.4, -2.2, 3.6, -1.2, 4.2, 2.4])  # minutes, AA..F9
CARRIER_CANCEL = np.array([1.00, 0.75, 1.15, 0.85, 1.45, 0.55, 1.75, 1.30])
HUB_DELAY = np.array(
    [1.2, 4.6, 2.9, 1.0, 0.6, 3.8, 1.9, 0.4, 1.1, 2.4, 5.1, 0.7, 2.6, 0.9, 1.7, 2.2, 2.0, 2.8, 0.5, 0.3]
)  # by HUBS order: congested east-coast hubs worst
DOW_DELAY = np.array([0.6, -1.4, -1.6, -0.4, 2.8, 0.9, 1.9])  # Mon..Sun


def build_month(seed: int, year: int, month: int, rows: int) -> pl.DataFrame:
    """Build one month of synthetic flight rows, deterministically from `seed`."""
    rng = np.random.default_rng(seed)

    # Carriers are *not* uniformly distributed - a few dominate, like reality.
    carrier_idx = rng.choice(
        len(CARRIERS), size=rows, p=[0.20, 0.17, 0.15, 0.18, 0.10, 0.08, 0.07, 0.05]
    )
    origin_idx = rng.integers(0, len(HUBS), size=rows)
    dest_idx = rng.integers(0, len(HUBS), size=rows)

    day = rng.integers(1, 29, size=rows)
    hour = rng.integers(5, 23, size=rows)
    base = np.datetime64(f"{year:04d}-{month:02d}-01", "D")
    fl_date = (base + day.astype("timedelta64[D]") + hour.astype("timedelta64[h]")).astype(
        "datetime64[us]"
    )

    weekday = (day.astype("int64") + 3) % 7 + 1

    # Weather: one shared shock per calendar day, plus a couple of storm days. This is
    # what makes "worst days" and cancellation spikes real rather than noise.
    day_shock = rng.normal(0, 4.5, size=28)
    storm_days = rng.choice(28, size=2, replace=False)
    day_shock[storm_days] += rng.uniform(18, 34, size=2)
    shock = day_shock[day - 1]

    # Delay accumulates through the day: early departures leave early, evening flights
    # inherit everything that went wrong upstream.
    hour_ramp = (hour - 5) * 0.85 - 4.0

    base_delay = (
        rng.normal(0, 14, size=rows)
        + CARRIER_DELAY[carrier_idx]
        + HUB_DELAY[origin_idx]
        + hour_ramp
        + DOW_DELAY[weekday - 1]
        + shock
    )
    late_mask = rng.random(rows) < 0.06
    base_delay[late_mask] += rng.integers(45, 240, size=late_mask.sum())

    distance = rng.integers(90, 2_480, size=rows).astype(np.int32)
    crs_elapsed = (distance * 1.18 + rng.integers(25, 55, size=rows)).astype(np.int32)

    dep_delay = np.rint(base_delay).astype(np.int32)
    # Longer flights recover a little time in the air; short hops cannot.
    arr_delay = np.rint(
        base_delay + rng.normal(0, 11, size=rows) - distance * 0.002
    ).astype(np.int32)
    air_time = crs_elapsed - rng.integers(0, 28, size=rows).astype(np.int32)

    cancel_p = np.clip(
        0.012 * CARRIER_CANCEL[carrier_idx] * (1.0 + np.maximum(shock, 0) / 16.0), 0.0, 0.35
    )
    cancelled = (rng.random(rows) < cancel_p).astype(np.int8)
    diverted = (rng.random(rows) < 0.0025).astype(np.int8)

    dep_delay = np.where(cancelled == 1, -999, dep_delay).astype(np.int32)
    arr_delay = np.where(cancelled == 1, -999, arr_delay).astype(np.int32)
    air_time = np.where(cancelled == 1, -999, air_time).astype(np.int32)

    df = pl.DataFrame(
        {
            "fl_date": pl.Series(fl_date, dtype=pl.Datetime("us")),
            "carrier": pl.Series(CARRIERS[carrier_idx], dtype=pl.String),
            "origin": pl.Series(HUBS[origin_idx], dtype=pl.String),
            "dest": pl.Series(HUBS[dest_idx], dtype=pl.String),
            "crs_dep_hour": pl.Series(hour, dtype=pl.Int8),
            "day_of_week": pl.Series(weekday, dtype=pl.Int8),
            "dep_delay": pl.Series(dep_delay, dtype=pl.Int32),
            "arr_delay": pl.Series(arr_delay, dtype=pl.Int32),
            "cancelled": pl.Series(cancelled, dtype=pl.Int8),
            "diverted": pl.Series(diverted, dtype=pl.Int8),
            "crs_elapsed_time": pl.Series(crs_elapsed, dtype=pl.Int32),
            "air_time": pl.Series(air_time, dtype=pl.Int32),
            "distance": pl.Series(distance, dtype=pl.Int32),
        }
    )

    return df.with_columns(
        pl.when(pl.col("dep_delay") == -999).then(None).otherwise(pl.col("dep_delay")).alias("dep_delay"),
        pl.when(pl.col("arr_delay") == -999).then(None).otherwise(pl.col("arr_delay")).alias("arr_delay"),
        pl.when(pl.col("air_time") == -999).then(None).otherwise(pl.col("air_time")).alias("air_time"),
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--rows-per-month", type=int, default=180_000)
    ap.add_argument("--months", type=int, default=24)
    ap.add_argument("--start-year", type=int, default=2024)
    ap.add_argument("--out", type=Path, default=Path(__file__).parent / "data" / "flights")
    # SNAPPY, not ZSTD. hyparquet (the browser reader that actually issues HTTP
    # range requests) ships snappy/gzip/brotli but has no ZSTD decoder, so a
    # ZSTD-published corpus cannot be read client-side at all. SNAPPY costs
    # roughly 20-30% more bytes and removes the entire class of problem.
    ap.add_argument("--compression", default="snappy", choices=["snappy", "zstd", "gzip", "lz4", "uncompressed"])
    ap.add_argument("--compression-level", type=int, default=None)
    args = ap.parse_args()

    if args.out.exists():
        for old in args.out.rglob("*.parquet"):
            old.unlink()

    started = time.perf_counter()
    total_rows = 0
    partitions: list[dict[str, object]] = []

    for offset in range(args.months):
        year = args.start_year + (offset // 12)
        month = (offset % 12) + 1
        df = build_month(offset + 1, year, month, args.rows_per_month)
        # Hive-style layout: year=2024/month=5/data.parquet. Written explicitly
        # rather than via partition_by so the partition keys are NOT duplicated
        # inside the file (DuckDB derives them from the path instead).
        part = args.out / f"year={year}" / f"month={month:02d}"
        part.mkdir(parents=True, exist_ok=True)
        kwargs = {"compression": args.compression}
        if args.compression_level is not None:
            kwargs["compression_level"] = args.compression_level
        target = part / "data.parquet"
        df.write_parquet(target, **kwargs)
        total_rows += df.height
        partitions.append(
            {
                "year": year,
                "month": month,
                "rows": df.height,
                "bytes": target.stat().st_size,
                # Bucket-relative path: the client joins this onto its data base URL,
                # so the layout can change without a code change in the app.
                "path": target.relative_to(args.out.parent).as_posix(),
            }
        )
        print(f"  {year}-{month:02d}  {df.height:>9,} rows")

    files = sorted(args.out.rglob("*.parquet"))
    total_bytes = sum(f.stat().st_size for f in files)

    # Shape consumed by packages/data-core/src/manifest.ts. Per-partition byte sizes
    # let the app report "% of the corpus you just read" without HEADing every file.
    manifest = {
        "dataset": {
            "name": "US domestic flights — BTS On-Time Performance schema",
            "source": "https://www.transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FGJ",
            "synthetic": True,
            "note": (
                "Synthetic data shaped like BTS On-Time Performance: same 13 columns, same "
                "Hive partitions, same order of magnitude of bytes per column. NOT real "
                "flight records — do not present it as such."
            ),
            "columns": [
                "fl_date",
                "carrier",
                "origin",
                "dest",
                "crs_dep_hour",
                "day_of_week",
                "dep_delay",
                "arr_delay",
                "cancelled",
                "diverted",
                "crs_elapsed_time",
                "air_time",
                "distance",
            ],
        },
        "generated_by": "pipelines/bts/generate_sample.py",
        "compression": args.compression,
        "partitions": partitions,
        "totals": {"files": len(files), "rows": total_rows, "bytes": total_bytes},
    }
    manifest_path = args.out.parent / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    elapsed = time.perf_counter() - started
    mib = total_bytes / 1024 / 1024
    print(f"\n{total_rows:,} rows -> {len(files)} parquet files, {mib:.1f} MiB, in {elapsed:.1f}s")
    print(f"manifest: {manifest_path}")


if __name__ == "__main__":
    main()
