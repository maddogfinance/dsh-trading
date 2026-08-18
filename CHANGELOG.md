# Changelog

## Unreleased

- `@dsh-trading/provider-csv` — `parseCsv` now enforces the parts of the
  contract it previously only documented: bar times must carry a timezone
  designator (a naive local time parses differently per machine and breaks
  replay), rows must be strictly ascending (duplicates and out-of-order rows
  are refused with line numbers — every indicator upstream assumes ascending
  bars), and a bar whose high is below its low is refused.

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

- `@dsh-trading/provider-csv` — `parseCsv` now enforces the parts of the
  contract it previously only documented: bar times must carry a timezone
  designator (a naive local time parses differently per machine and breaks
  replay), rows must be strictly ascending (duplicates and out-of-order rows
  are refused with line numbers — every indicator upstream assumes ascending
  bars), and a bar whose high is below its low is refused.
>>>>>>> 0e8e759 (provider-csv: enforce the time contract parseCsv only documented)

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
