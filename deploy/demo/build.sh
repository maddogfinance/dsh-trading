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

echo "== docker build ($TAG)"
docker build --network host -t "$TAG" "$HERE"
