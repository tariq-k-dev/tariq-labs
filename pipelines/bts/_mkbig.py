
import sys, time, argparse
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from generate_sample import build_month

ap = argparse.ArgumentParser()
ap.add_argument("--rows", type=int, default=3_000_000)
ap.add_argument("--compression", default="snappy")
args = ap.parse_args()

# Must land under the mock-R2 root (pipelines/bts/data) so the server can serve
# it as flights/big/data.parquet. Resolve from this file, never from cwd.
out = Path(__file__).parent / "data" / "flights" / "big"
out.mkdir(parents=True, exist_ok=True)
t0 = time.perf_counter()
df = build_month(99, 2025, 1, args.rows)
path = out / "data.parquet"
df.write_parquet(path, compression=args.compression)
print(f"{df.height:,} rows -> {path} ({path.stat().st_size/1024/1024:.2f} MiB, {args.compression}) in {time.perf_counter()-t0:.1f}s")
