"""Probe the real BTS On-Time Performance CSV to design the ingest.

Answers, with measurements rather than assumptions:
  1. Real row count and column set for one month.
  2. Which of the 13 columns Querylens needs actually exist, and under what names.
  3. Missing-value conventions (`-999`? empty string? null?) per column.
  4. Per-column Parquet bytes, so the projection can be chosen by cost, not guess.
  5. Whether `CRSDepTime` can produce a local departure hour without a timezone table.

Usage:
    uv run python bts/probe_real.py path/to/On_Time_..._2025_8.zip
"""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path

import polars as pl

# The projection Querylens needs, real BTS name -> our client-facing name.
SOURCE_TO_TARGET: dict[str, str] = {
    "FlightDate": "fl_date",
    "Reporting_Airline": "carrier",
    "Origin": "origin",
    "Dest": "dest",
    "CRSDepTime": "crs_dep_time",
    "DayOfWeek": "day_of_week",
    "DepDelay": "dep_delay",
    "ArrDelay": "arr_delay",
    "Cancelled": "cancelled",
    "Diverted": "diverted",
    "CRSElapsedTime": "crs_elapsed_time",
    "AirTime": "air_time",
    "Distance": "distance",
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("archive", type=Path)
    args = ap.parse_args()

    with zipfile.ZipFile(args.archive) as archive:
        csv_name = next(n for n in archive.namelist() if n.endswith(".csv"))
        print(f"archive   {args.archive.name}")
        print(f"member    {csv_name}  ({archive.getinfo(csv_name).file_size:,} B uncompressed)")
        with archive.open(csv_name) as handle:
            # Read everything as string first: BTS writes "" for missing and, in some
            # vintages, -999. Reading with inferred dtypes silently turns both into
            # surprises, so inspect the raw text before casting.
            raw = pl.read_csv(handle, infer_schema_length=0, ignore_errors=True)

    print(f"rows      {raw.height:,}")
    print(f"columns   {raw.width}")

    missing = [c for c in SOURCE_TO_TARGET if c not in raw.columns]
    print(f"\nmapping: {'ALL PRESENT' if not missing else 'MISSING ' + ', '.join(missing)}")
    if missing:
        raise SystemExit(1)

    print("\nmissing-value conventions (raw text, per needed column):")
    for source in SOURCE_TO_TARGET:
        series = raw[source]
        blank = (series == "").sum()
        dash = (series == "-999").sum()
        null = series.null_count()
        print(
            f"  {source:20s} blank={blank:>8,}  '-999'={dash:>8,}  null={null:>8,}"
        )

    print("\nsample values:")
    for source in SOURCE_TO_TARGET:
        vals = raw[source].drop_nulls().unique().head(5).to_list()
        print(f"  {source:20s} {vals}")

    # ---- the projection, cast to the types the browser reader expects ----------
    #
    # Every numeric BTS column arrives as TEXT with a decimal point ("0.00", "215.00"),
    # so `cast(Int8, strict=False)` returns NULL for all of them rather than failing —
    # silently turning Cancelled and Distance into empty columns. Go through Float64
    # first; the first run of this probe produced five 100%-null columns that way.
    def numeric(source: str, dtype: pl.DataType) -> pl.Expr:
        return pl.col(source).cast(pl.Float64, strict=False).round(0).cast(dtype)

    frame = raw.select(
        [
            pl.col("FlightDate").str.slice(0, 10).str.to_date("%Y-%m-%d").alias("fl_date"),
            pl.col("Reporting_Airline").alias("carrier"),
            pl.col("Origin").alias("origin"),
            pl.col("Dest").alias("dest"),
            # CRSDepTime is a local-time HHMM string ("0719"; "5" for 00:05; "2400" at
            # midnight). zfill(4) then take the first two digits, and fold 24 -> 0.
            (
                pl.col("CRSDepTime")
                .str.zfill(4)
                .str.slice(0, 2)
                .cast(pl.Int8, strict=False)
                .replace(24, 0)
            ).alias("crs_dep_hour"),
            numeric("DayOfWeek", pl.Int8).alias("day_of_week"),
            numeric("DepDelay", pl.Int32).alias("dep_delay"),
            numeric("ArrDelay", pl.Int32).alias("arr_delay"),
            numeric("Cancelled", pl.Int8).alias("cancelled"),
            numeric("Diverted", pl.Int8).alias("diverted"),
            numeric("CRSElapsedTime", pl.Int32).alias("crs_elapsed_time"),
            numeric("AirTime", pl.Int32).alias("air_time"),
            numeric("Distance", pl.Int32).alias("distance"),
        ]
    )

    # BTS writes blank for a missing delay. A few vintages also write -999; normalise it
    # to null so no aggregation ever averages a sentinel into its mean.
    frame = frame.with_columns(
        [
            pl.when(pl.col(c) <= -999).then(None).otherwise(pl.col(c)).alias(c)
            for c in ("dep_delay", "arr_delay", "air_time", "crs_elapsed_time", "distance")
        ]
    )

    # The validation gate: every one of these must be a real column, not an all-null accident.
    for name in frame.columns:
        if frame[name].null_count() == frame.height:
            raise SystemExit(f"FATAL: column '{name}' is entirely null after the cast — check the source encoding")

    print(f"\nprojection rows {frame.height:,}")
    print(frame.head(3))
    print("\nnulls after normalisation:")
    for name in frame.columns:
        n = frame[name].null_count()
        if n:
            print(f"  {name:20s} {n:>8,}  ({n / frame.height * 100:.2f}%)")

    # ---- cost of the projection, per column, as Parquet -----------------------
    out = Path("bts/_probe.parquet")
    frame.write_parquet(out, compression="snappy")
    total = out.stat().st_size
    print(f"\nprojected parquet (snappy): {total:,} B = {total / 1024 / 1024:.2f} MiB")

    per_column: list[tuple[str, int]] = []
    for name in frame.columns:
        single = Path("bts/_probe_one.parquet")
        frame.select(name).write_parquet(single, compression="snappy")
        per_column.append((name, single.stat().st_size))
        single.unlink()
    out.unlink()

    print("\nper-column parquet bytes (write cost, not read cost):")
    for name, size in sorted(per_column, key=lambda kv: -kv[1]):
        share = size / total * 100
        print(f"  {name:20s} {size:>10,} B  {share:5.1f}%")

    # ---- what a two-column question would cost -------------------------------
    two = frame.select(["carrier", "dep_delay"])
    pair = Path("bts/_probe_pair.parquet")
    two.write_parquet(pair, compression="snappy")
    print(
        f"\ntwo-column question file (carrier+dep_delay): {pair.stat().st_size:,} B "
        f"= {pair.stat().st_size / total * 100:.1f}% of the projection"
    )
    pair.unlink()


if __name__ == "__main__":
    main()
