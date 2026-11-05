#!/usr/bin/env bash
# Build the public TradingDraw image from this checkout.
#
# Prereqs: pnpm install at the repo root, Docker. On this machine the Docker
# bridge cannot reach the npm registry, so the build uses --network host.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TAG="${1:-dash-trading:local}"

echo "== building packages"
(cd "$ROOT/packages/provider-public" && pnpm build >/dev/null)
(cd "$ROOT/packages/tool-market" && pnpm build >/dev/null)
(cd "$ROOT/packages/client-chart" && pnpm build >/dev/null)
(cd "$ROOT/packages/client-frame" && pnpm build >/dev/null)

# tool-market ships from the checkout too: the walkthrough tool is newer than its npm release.
echo "== packing the packages the demo takes from this checkout"
mkdir -p "$HERE/artifacts"
(cd "$ROOT/packages/provider-public" && npm pack --silent >/dev/null)
(cd "$ROOT/packages/tool-market" && npm pack --silent >/dev/null)
(cd "$ROOT/packages/client-chart" && npm pack --silent >/dev/null)
(cd "$ROOT/packages/client-frame" && npm pack --silent >/dev/null)
cp "$ROOT/packages/provider-public/dsh-trading-provider-public-0.2.0.tgz" "$HERE/artifacts/dsh-trading-provider-public.tgz"
cp "$ROOT/packages/tool-market/dsh-trading-tool-market-0.2.0.tgz" "$HERE/artifacts/dsh-trading-tool-market.tgz"
cp "$ROOT/packages/client-chart/dsh-trading-client-chart-0.2.0.tgz" "$HERE/artifacts/dsh-trading-client-chart.tgz"
cp "$ROOT/packages/client-frame/dsh-trading-client-frame-0.2.0.tgz" "$HERE/artifacts/dsh-trading-client-frame.tgz"
rm -f "$ROOT/packages/provider-public"/*.tgz "$ROOT/packages/tool-market"/*.tgz "$ROOT/packages/client-chart"/*.tgz "$ROOT/packages/client-frame"/*.tgz

# The lock records an integrity hash for each packed tarball. Repacking one
# changes its bytes, and npm then installs the copy it has cached under the OLD
# hash: the image silently keeps the previous build while every step reports
# success. Rewrite the four hashes from the bytes on disk, so the cache misses
# and npm reads the tarball in this build context.
echo "== refreshing the lock's local tarball hashes"
python3 - "$HERE" <<'PY'
import base64, hashlib, json, sys
here = sys.argv[1]
path = f"{here}/package-lock.json"
with open(path, encoding="utf-8") as fh:
    lock = json.load(fh)
changed = 0
for key, entry in lock.get("packages", {}).items():
    resolved = entry.get("resolved", "")
    if not resolved.startswith("file:artifacts/"):
        continue
    with open(f"{here}/{resolved[len('file:'):]}", "rb") as fh:
        digest = base64.b64encode(hashlib.sha512(fh.read()).digest()).decode()
    entry["integrity"] = f"sha512-{digest}"
    changed += 1
with open(path, "w", encoding="utf-8") as fh:
    json.dump(lock, fh, indent=2)
    fh.write("\n")
print(f"   {changed} local tarball hashes updated")
PY

echo "== docker build ($TAG)"
docker build --network host -t "$TAG" "$HERE"
