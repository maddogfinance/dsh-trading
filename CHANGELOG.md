# Changelog

## Unreleased

- `@dsh-trading/risk-guard` — deny patterns now also match normalized tool
  names: camelCase is split (`placeOrder`), and namespaced names are checked
  per segment (`mcp__ib__place_order`, `broker.place_order`, `exchange/sell`),
  closing the systematic bypass where only textbook snake_case spellings were
  caught. Anchors still anchor per candidate (`uniswap` never matches
  `^swap`); the `allow` list still exempts the exact raw name. New export:
  `nameCandidates`.

## 0.1.1 — 2026-08-17

- `@dsh-trading/client-chart`: fix the scenario reader to match the published
  v1 contract — `stance` is required, `triggerPrice`/`invalidationPrice` are
  preserved so scenario trigger/invalidation lines render on the chart, and
  legacy `weight`-shaped scenarios are dropped gracefully. Restores strict
  client type checking via klinecharts public types. Contributed by
  [@abigfatstone](https://github.com/abigfatstone) in
  [#1](https://github.com/maddogfinance/dsh-trading/pull/1) — this project's
  first outside contribution.
- All packages: add npm keywords for ecosystem discovery.
=======
## Unreleased

- `@dsh-trading/risk-guard` — deny patterns now also match normalized tool
  names: camelCase is split (`placeOrder`), and namespaced names are checked
  per segment (`mcp__ib__place_order`, `broker.place_order`, `exchange/sell`),
  closing the systematic bypass where only textbook snake_case spellings were
  caught. Anchors still anchor per candidate (`uniswap` never matches
  `^swap`); the `allow` list still exempts the exact raw name. New export:
  `nameCandidates`.
>>>>>>> d1a7a46 (risk-guard: match deny patterns against normalized tool names)

## 0.1.0 — 2026-08-17

First public release. Five packages plus the profile bundle, published as
`@dsh-trading/*` on npm.

- `@dsh-trading/market-data` — the typed `ctx.marketData` seam: one candle/symbol
  interface, any provider behind it.
- `@dsh-trading/provider-csv` — bring-your-own-data reference provider (local
  CSV files).
- `@dsh-trading/tool-market` — `list_symbols`, `get_ohlcv`, `market_snapshot`
  (multi-timeframe indicator regime in one call), `render_chart` (deterministic
  SVG), and `annotate_chart` — model-authored levels/zones/paths behind a trust
  gate: mandatory provenance sources, prices hard-validated against the real
  candle window (projection roles get a wider band), path times window-checked,
  scenarios restricted to base/alternative hypotheses with triggers and
  invalidations. Chart payloads ride `presentationMeta` on the durable session
  log: model-invisible, replay-safe.
- `@dsh-trading/risk-guard` — refuses execution-shaped tool names from any
  plugin at dsh's `tools/pre-execute` gate.
- `@dsh-trading/client-chart` — interactive candlestick cards in `dsh web`:
  chip-toggled indicator panes drawn from the exact per-bar series the model
  read, timeframe tabs, annotation overlays with a provenance levels table and
  scenario strips, plus an open renderer registry
  (`registerAnnotationRenderer`) for ecosystem annotation types.
- `CONTRACTS.md` — the versioned open contracts: chart payload schema, open
  annotation envelope, pure-renderer draw primitives, frozen v1 names.
- Pinned against dsh `0.1.0-rc.6`.
