# dsh-trading

A trading **research** workbench built as plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). No fork, no patched core — just a bundle you stack on the stock `web` or `headless` profile.

> **Status: early scaffold.** dsh itself is in developer preview and moves fast; expect breaking changes on both sides.

## Demo

[![Interactive chart cards in dsh web: chips toggle indicator panes drawn from the model's own numbers; annotate_chart draws provenance-gated levels](media/demo-preview.gif)](https://www.youtube.com/watch?v=9KLpy-jPtKY)

▶ **[Watch the full 80-second demo with narration on YouTube](https://www.youtube.com/watch?v=9KLpy-jPtKY)** —
the agent answers with an interactive chart card, chips draw indicator panes
from the exact per-bar series the model read, and `annotate_chart` puts levels
on the chart through a trust gate: mandatory provenance, prices validated
against the real candle window. All footage is a live session, no mockups.

## Design

Five packages, one direction of dependency:

```
@dsh-trading/tool-market      model-facing tools (list_symbols, get_ohlcv,
                              market_snapshot) + the indicator library
        │  consumes
        ▼
@dsh-trading/market-data      the seam: ctx.marketData — typed candle/symbol interface
        ▲  implements
        │
@dsh-trading/provider-csv     reference provider: local CSV files

@dsh-trading/risk-guard       independent: refuses execution-shaped tool names
                              from any plugin, at dsh's tools/pre-execute gate

@dsh-trading/client-chart     web-only: candlestick cards for market_snapshot /
                              get_ohlcv results in dsh web (no host capability)
```

- **`market-data`** defines the seam and nothing else (its only peer is cordis). Every consumer talks to `ctx.marketData`; every data source hides behind `MarketDataProvider`.
- **`provider-csv`** is the *bring-your-own-data* template: ~100 lines, local `<root>/<symbol>/<timeframe>.csv` files. Copy it to put ClickHouse, a broker API, or CCXT behind the same interface — tools upstream never change.
- **`tool-market`** registers read-only analysis tools on `ctx.tools`. `market_snapshot` returns a whole multi-timeframe indicator regime in one call (RSI, slow stochastic, ADX/DI, MACD, MFI, ATR, SMA/EMA posture, Bollinger) with coarse state labels; `get_ohlcv` serves raw bars when structure matters. The indicator math is pure and deterministic — textbook definitions with Wilder smoothing where Wilder defined it — so values reconcile against any charting platform and a session-log replay recomputes identical model-visible numbers.
- **`bundle/trading`** wires the rows into a dsh profile via `cordis.patch.yml`. Users repoint or replace the `market-data-provider` row from their own profile patch — that row swap **is** the BYO mechanism.

## Why this and not another finance plugin?

Data plugins hard-wire one source; dsh-trading defines the seam they can all plug
into. Quant toolkits ship one tool per indicator; `market_snapshot` returns the
whole multi-timeframe regime in one call, with state labels computed from the
rounded reported values so chart and number never disagree. And everyone else's
"research only" is a README sentence — ours is a `tools/pre-execute` gate you can
test.

## Hard boundary: research only

This project deliberately has **no order-execution capability and no execution seam**. Tools read data and compute; nothing places, routes, or simulates-then-forwards orders. Contributions adding live trading execution are out of scope. Nothing here is investment advice.

`@dsh-trading/risk-guard` extends that stance over plugins this project does not ship: it refuses order-execution and fund-movement tool names at dsh's `tools/pre-execute` gate, so mounting a broker plugin in a `trading` profile does not quietly gain the ability to trade. Name matching is a heuristic and cannot be complete — the guard is defense in depth, not the guarantee. The guarantee is structural: there is no execution seam to reach.

## Data format (CSV provider)

```
data/
  AAPL/
    1d.csv        # header: time,open,high,low,close,volume
  BTC-USDT/
    1h.csv        # ISO-8601 UTC bar-open times, ascending
```

## Try it with dsh

One command — the published bundle pulls every plugin package from npm:

```sh
dsh plugin --profile trading add @dsh-trading/bundle
```

<details>
<summary>Or from a checkout (for hacking on the packages)</summary>

Build, then compose the profile from local paths (dsh resolves plugin rows
from the profile directory, so the packages must be linked alongside the
bundle):

```sh
pnpm install && pnpm build
node examples/generate-sample-data.mjs

dsh plugin --profile trading add ./bundle/trading \
    ./packages/market-data ./packages/provider-csv ./packages/tool-market \
    ./packages/risk-guard ./packages/client-chart
```

</details>

Add `"@deepseek-ai/dsh-headless"` (or `"@deepseek-ai/dsh-web-app"`) after
`@deepseek-ai/dsh-base` in the profile's `dsh.profile.bundles` list
(`$DSH_HOME/profiles/trading/package.json`) to pick a surface, configure a model
key (environment `DEEPSEEK_API_KEY`, or the Models page under `dsh web`), and
run from any directory whose `./data` holds candles in the layout below:

```sh
cd examples && dsh --profile trading "pull DEMO-EQ daily candles with sma20/sma50 and describe the trend"
```

Verify the composed layers any time with `dsh --profile trading --dump-config`.

### The Market Analyst preset

`presets/analyst/` is an agent preset that turns the raw tools into a structured
analysis workflow: it scopes the request first (horizon, focus, timeframes),
then reports higher-timeframe context, a key-level table, the multi-timeframe
indicator regime with conflicts named rather than averaged away, bull and bear
scenarios with triggers and invalidation, and the levels that resolve the
ambiguity. Install it and pick **Market Analyst** in the session's preset menu:

```sh
mkdir -p "$DSH_HOME/.agent-presets" && cp -r presets/analyst "${DSH_HOME:-$HOME/.dsh}/.agent-presets/"
```

The persona holds the research boundary in prose the way `risk-guard` holds it
in code: report what the data shows, never recommend a position or an entry.

### Chart cards in `dsh web`

Under the `web` surface, `market_snapshot` and `get_ohlcv` results render as
interactive candlestick cards (`@dsh-trading/client-chart`): K-line + volume +
SMA20/50/200, timeframe tabs, and a chip strip showing the exact indicator
values the model read. The chart data rides the durable `tool/result` event's
presentation metadata — it never enters the model's context (zero token cost)
and it replays with the session log. The chart pane draws only unambiguous
math (candles, SMA, volume); every other indicator appears as the
RegimeSnapshot's own numbers, so the card can never contradict the analysis
text beside it. Headless profiles ignore the package; without it, dsh falls
back to the generic text card.

## Development

```sh
pnpm install
pnpm typecheck
pnpm build
```

## Roadmap

- [ ] Profile template + docs for stacking onto `dsh --profile web`
- [x] Chart cards in `dsh web` (`@dsh-trading/client-chart`): `market_snapshot` / `get_ohlcv` render as interactive candlesticks with chip-toggled indicator panes
- [x] `annotate_chart`: model-authored levels/zones/paths with mandatory provenance and a hard price-range gate, plus base/alternative scenarios — rendered on the card with a levels table
- [x] Open contracts for ecosystem builders ([CONTRACTS.md](./CONTRACTS.md)): chart payload, open annotation envelope, pure-renderer registry
- [ ] Chart panel deepening: user-drawing feedback to the agent, `@Remote` host service for pan-back data
- [ ] Watch/alert contract (notify-only), `@dsh-trading/contracts` package, conformance fixtures
- [ ] Research-journal session events (hypotheses, signals — replayable)
- [ ] Deterministic backtest runner as a `ctx.commands` CLI command (never model-executed)
- [ ] More providers: Parquet, ClickHouse, CCXT

## License

MIT
