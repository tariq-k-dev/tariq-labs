"""Fetch real BTS On-Time Performance months and publish partitioned Parquet.

Replaces the synthetic fixture with the actual public data. Nothing here runs at
request time: the browser only ever reads the Parquet this writes.

Source
------
TranStats serves one zip per month at a static URL — no session, no form POST, no key:

    https://transtats.bts.gov/PREZIP/On_Time_Reporting_Carrier_On_Time_Performance_1987_present_YYYY_M.zip

Each zip holds a ~270 MB CSV with 110 columns; the projection below keeps 13. Measured
on 2025-08: 602,378 rows, 3.80 MiB of SNAPPY Parquet.

Usage
-----
    uv run python bts/fetch.py --months 2025-03 2025-08        # a range
    uv run python bts/fetch.py --months 2024-01 2025-12 --keep-csv
    uv run python bts/fetch.py --from-manifest                 # re-run what the manifest lists

Traps this script exists to avoid
--------------------------------
* BTS writes numeric columns as TEXT WITH A DECIMAL POINT ("0.00"). Casting straight to
  an integer type yields NULL for every row rather than raising, so the whole column
  silently becomes empty. Go through Float64 and assert no column is all-null.
* `CRSDepTime` is a local HHMM string: "0719", "5" (00:05), "2400" (midnight).
* Missing delays are blank; some vintages also write -999. Both must become null or an
  average quietly includes a sentinel.
* A month mid-way through being published returns a tiny/partial zip. Reject a month
  whose row count is far below the running median rather than publishing a truncated
  partition.
"""

from __future__ import annotations

import argparse
import json
import shutil
import statistics
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import polars as pl

BASE_URL = (
    "https://transtats.bts.gov/PREZIP/"
    "On_Time_Reporting_Carrier_On_Time_Performance_1987_present_{year}_{month}.zip"
)

HERE = Path(__file__).resolve().parent
DATA_ROOT = HERE / "data"
FLIGHTS = DATA_ROOT / "flights"
CACHE = HERE / ".cache"

# Real BTS column -> the name the browser app reads. Keep this list and
# packages/data-core/src/catalog.ts FLIGHT_COLUMNS in step; the app plans its reads
# off that catalog, so a rename here without one there is a runtime 404 on a column.
SOURCE_TO_TARGET = {
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

DATASET = {
    "name": "US domestic flights — BTS On-Time Performance",
    "source": "https://www.transtats.bts.gov/DL_SelectFields.aspx?gnoyr_VQ=FGJ",
    "synthetic": False,
    "note": (
        "Real BTS Reporting Carrier On-Time Performance, projected from 110 columns to the "
        "13 this app queries. Missing delays are null, not zero and not a sentinel. "
        "Reporting carriers only — regional partners appear under their own code."
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
}


def month_range(start: str, end: str) -> list[tuple[int, int]]:
    """Inclusive list of (year, month) between two YYYY-MM strings."""
    sy, sm = (int(part) for part in start.split("-"))
    ey, em = (int(part) for part in end.split("-"))
    out: list[tuple[int, int]] = []
    year, month = sy, sm
    while (year, month) <= (ey, em):
        out.append((year, month))
        month += 1
        if month == 13:
            year, month = year + 1, 1
    return out


def download(year: int, month: int, *, keep: bool) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    target = CACHE / f"{year}_{month:02d}.zip"
    if target.exists() and target.stat().st_size > 1_000_000:
        print(f"    cached  {target.name}  ({target.stat().st_size:,} B)")
        return target

    url = BASE_URL.format(year=year, month=month)
    request = urllib.request.Request(url, headers={"User-Agent": "tariq-labs-ingest/1.0"})
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            data = response.read()
    except urllib.error.HTTPError as error:
        raise SystemExit(f"    HTTP {error.code} for {url} — month not published yet?") from error

    if len(data) < 1_000_000:
        raise SystemExit(f"    {len(data):,} B from {url} — too small to be a month")
    target.write_bytes(data)
    elapsed = time.perf_counter() - started
    print(f"    fetched {len(data) / 1024 / 1024:.1f} MiB in {elapsed:.1f}s")
    if not keep:
        pass  # kept regardless: re-runs and the integrity check need the original
    return target


def numeric(source: str, dtype: pl.DataType) -> pl.Expr:
    """BTS numerics are text with decimals; Int targets need the Float64 hop."""
    return pl.col(source).cast(pl.Float64, strict=False).round(0).cast(dtype)


def project(frame: pl.DataFrame) -> pl.DataFrame:
    missing = [c for c in SOURCE_TO_TARGET if c not in frame.columns]
    if missing:
        raise SystemExit(f"    source is missing expected columns: {', '.join(missing)}")

    projected = frame.select(
        [
            pl.col("FlightDate").str.slice(0, 10).str.to_date("%Y-%m-%d").alias("fl_date"),
            pl.col("Reporting_Airline").alias("carrier"),
            pl.col("Origin").alias("origin"),
            pl.col("Dest").alias("dest"),
            pl.col("CRSDepTime")
            .str.zfill(4)
            .str.slice(0, 2)
            .cast(pl.Int8, strict=False)
            .replace(24, 0)
            .alias("crs_dep_hour"),
            numeric("DayOfWeek", pl.Int8).alias("day_of_week"),
            numeric("DepDelay", pl.Int32).alias("dep_delay"),
            numeric("ArrDelay", pl.Int32).alias("arr_delay"),
            numeric("Cancelled", pl.Int8).alias("cancelled"),
            numeric("Diverted", pl.Int8).alias("diverted"),
            numeric("CRSElapsedTime", pl.Int32).alias("crs_elapsed_time"),
            numeric("AirTime", pl.Int32).alias("air_time"),
            numeric("Distance", pl.Int32).alias("distance"),
        ]
    ).with_columns(
        [
            pl.when(pl.col(c) <= -999).then(None).otherwise(pl.col(c)).alias(c)
            for c in ("dep_delay", "arr_delay", "air_time", "crs_elapsed_time", "distance")
        ]
    )

    # Gate: an all-null column means the cast failed silently, which is exactly how the
    # first version of this pipeline shipped five empty columns and looked successful.
    for name in projected.columns:
        if projected[name].null_count() == projected.height:
            raise SystemExit(f"    column '{name}' is 100% null after projection — refusing to publish")
    return projected


def transform(archive: Path, year: int, month: int, row_group_size: int) -> dict[str, object]:
    with zipfile.ZipFile(archive) as bundle:
        csv_name = next(n for n in bundle.namelist() if n.endswith(".csv"))
        with bundle.open(csv_name) as handle:
            raw = pl.read_csv(
                handle,
                infer_schema_length=0,  # keep everything as text so nothing is guessed
                ignore_errors=True,
            )

    frame = project(raw)
    part = FLIGHTS / f"year={year}" / f"month={month:02d}"
    part.mkdir(parents=True, exist_ok=True)
    target = part / "data.parquet"
    frame.write_parquet(target, compression="snappy", row_group_size=row_group_size)

    return {
        "year": year,
        "month": month,
        "rows": frame.height,
        "bytes": target.stat().st_size,
        "path": target.relative_to(DATA_ROOT).as_posix(),
        "null_dep_delay": frame["dep_delay"].null_count(),
        "source_rows": raw.height,
        "source_columns": raw.width,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--months", nargs=2, metavar=("START", "END"), help="inclusive, e.g. 2025-03 2025-08")
    ap.add_argument("--list", nargs="+", metavar="YYYY-MM", help="explicit months instead of a range")
    ap.add_argument(
        "--row-group-size",
        type=int,
        default=700_000,
        help="rows per Parquet row group. Measured: 700_000 puts one row group in a monthly "
        "file, which halves the range requests per query (9-15 vs 18-40) and halves the "
        "footer (2.5 kB vs 5.6 kB), for 6% more bytes. We never row-filter, so there is no "
        "pruning to lose by making row groups large. Default 700_000.",
    )
    ap.add_argument("--keep-csv", action="store_true", help="no-op; the zip is always kept for re-runs")
    ap.add_argument("--min-rows", type=int, default=300_000, help="reject a month below this row count")
    args = ap.parse_args()

    if args.list:
        months = [tuple(int(p) for p in item.split("-")) for item in args.list]
    elif args.months:
        months = month_range(*args.months)
    else:
        ap.error("give --months START END or --list YYYY-MM [...]")

    print(f"{len(months)} month(s) -> {FLIGHTS}")
    started = time.perf_counter()
    partitions: list[dict[str, object]] = []
    rejected: list[str] = []

    for year, month in months:
        label = f"{year}-{month:02d}"
        print(f"  {label}")
        archive = download(year, month, keep=args.keep_csv)
        info = transform(archive, year, month, args.row_group_size)
        if int(info["rows"]) < args.min_rows:
            rejected.append(f"{label} ({info['rows']:,} rows)")
            (FLIGHTS / f"year={year}" / f"month={month:02d}" / "data.parquet").unlink(missing_ok=True)
            print(f"    REJECTED — only {info['rows']:,} rows")
            continue
        partitions.append(info)
        mib = int(info["bytes"]) / 1024 / 1024
        print(f"    {int(info['rows']):,} rows -> {mib:.2f} MiB parquet")

    if not partitions:
        raise SystemExit("no partitions produced")

    # A month far below its neighbours is a partially published file, not a quiet month.
    if len(partitions) > 2:
        median = statistics.median(int(p["rows"]) for p in partitions)
        for p in partitions:
            if int(p["rows"]) < median * 0.6:
                rejected.append(f"{p['year']}-{int(p['month']):02d} (outlier {int(p['rows']):,})")

    partitions.sort(key=lambda p: (int(p["year"]), int(p["month"])))
    total_rows = sum(int(p["rows"]) for p in partitions)
    total_bytes = sum(int(p["bytes"]) for p in partitions)

    manifest = {
        "dataset": DATASET,
        "generated_by": "pipelines/bts/fetch.py",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "compression": "snappy",
        "row_group_size": args.row_group_size,
        "partitions": partitions,
        "totals": {"files": len(partitions), "rows": total_rows, "bytes": total_bytes},
        "rejected": rejected,
    }
    manifest_path = DATA_ROOT / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    # A corpus must be exactly what the manifest lists. Stale synthetic partitions from
    # generate_sample.py living alongside real ones would produce a "real" manifest whose
    # byte totals and row counts are wrong — prune anything not in this run.
    expected = {(int(p["year"]), int(p["month"])) for p in partitions}
    pruned = 0
    for year_dir in sorted(FLIGHTS.glob("year=*")):
        try:
            year = int(year_dir.name.split("=")[1])
        except (IndexError, ValueError):
            continue
        for month_dir in sorted(year_dir.glob("month=*")):
            try:
                month = int(month_dir.name.split("=")[1])
            except (IndexError, ValueError):
                continue
            if (year, month) not in expected:
                shutil.rmtree(month_dir)
                pruned += 1
        if not any(year_dir.iterdir()):
            year_dir.rmdir()
    if pruned:
        print(f"pruned {pruned} partition(s) not in this manifest")

    elapsed = time.perf_counter() - started
    print(
        f"\n{total_rows:,} rows -> {len(partitions)} files, "
        f"{total_bytes / 1024 / 1024:.1f} MiB, in {elapsed / 60:.1f} min"
    )
    if rejected:
        print(f"rejected: {', '.join(rejected)}")
    print(f"manifest: {manifest_path}")

    # Do not let a stale synthetic manifest sit next to real data.
    if (DATA_ROOT / "flights" / "big").exists():
        shutil.rmtree(DATA_ROOT / "flights" / "big")
        print("removed the spike's big/ fixture")


if __name__ == "__main__":
    main()
