# dsh-trading open contracts

The seams third-party plugins build against. Everything here is versioned:
**within a version, changes are additive only**; breaking changes bump the
version and are called out in the changelog. Readers MUST ignore unknown
fields, pass unknown annotation `type`s through unmodified, and coerce unknown
`role` values to `'other'` — never crash on data from a newer producer.

Paste this file into your agent and vibecode against it.

## 1. Market-data provider seam

`ctx.marketData` (from `@dsh-trading/market-data`): implement
`MarketDataProvider { id, description, listSymbols(), getOhlcv(query) }`,
mount with `ctx.effect(() => ctx.marketData.register(provider))`, and every
tool upstream works against your data. `provider-csv` (~110 lines) is the
reference implementation. Swapping the `market-data-provider` row in a profile
`cordis.patch.yml` is the deployment mechanism.

## 2. Chart payload — `kind: 'chart'`, `version: 1`

Carried on the durable `tool/result` event's `meta` via dsh's
`output.presentationMeta`. Never model-visible; survives session replay.
Producers: `market_snapshot`, `get_ohlcv`, `annotate_chart`
(`@dsh-trading/tool-market`). Consumer: the card in
`@dsh-trading/client-chart` — or yours.

```jsonc
{
  "kind": "chart", "version": 1,
  "provider": "csv", "symbol": "DEMO-EQ",
  "timeframes": [{
    "timeframe": "1d",
    "candles": [{ "time": "2026-01-27T08:00:00.000Z", "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 100 }],
    "indicators": { /* RegimeSnapshot, see §2.1 */ },
    "series": { "rsi14": [null, 54.33], "macd_hist": [null, -0.2013] },
    "annotations": [ /* §3 */ ]
  }],
  "scenarios": [ /* §4 */ ]
}
```

- `candles`: ≤ 200 bars, ascending ISO-8601 UTC bar-open times, all finite.
- `series`: per-bar columns aligned index-for-index with `candles`; leading
  unseeded positions are `null`.

### 2.1 Frozen names (part of version 1)

`RegimeSnapshot` fields: `bars, lastTime, close, changePct, rsi14{value,state},
stochastic{k,d,state}, adx14{value,plusDi,minusDi,state},
macd{line,signal,histogram,state}, mfi14{value,state}, atr14{value,pctOfClose},
movingAverages{sma20,sma50,sma200,ema20,closeVs}, bollinger20{upper,middle,lower,state}`.
Series columns: `rsi14, stoch_k, stoch_d, adx, plus_di, minus_di, macd,
macd_signal, macd_hist, mfi14, bb_upper, bb_middle, bb_lower`. Values are
rounded once, producer-side, so any consumer shows exactly what the model read.
Renaming any of these is a breaking change.

## 3. Annotation envelope (open)

`annotations` is an **open array**: every entry has a string `type`; core
types are `level`, `zone`, `path` (shapes in
`packages/tool-market/src/chart-payload.ts`). Conventional optional fields for
new types: `label`, `role`, `sources`, `points`. Rules:

- **Provenance is mandatory** for core types: `sources` (1–6 human-readable
  strings) names the evidence. v1 provenance is free text — it proves the
  model *stated* a basis, not that the basis is correct; machine-checkable
  source variants (e.g. `{kind:'fib', ratio:0.618}`) are a planned v2.
- **Producers validate themselves.** `annotate_chart` hard-validates prices
  into the drawn window (`×0.7..×1.3` of its low..high; roles
  `target`/`invalidation` get `×0.5..×2.0`), path times into the window
  (+10% forward projection), zone width ≥ 0.05% of close, counts ≤ 24, and
  strips control characters from all strings. Third-party authoring tools
  should hold the same line.
- The gate is a plausibility check against the window the tool itself
  fetched, not proof of correctness — on wide-range windows it is loose, and
  refetching means minor drift from the window the model analyzed.
- Renderers receive model-authored text: render with `textContent`, never
  `innerHTML`.
- Each `annotate_chart` call is standalone: it re-emits the full picture.
  There is no cross-call merge; the newest card is the current analysis.

## 4. Scenario vocabulary

`{ direction: 'bull'|'bear', stance: 'base'|'alternative', thesis, trigger,
invalidation, triggerPrice?, invalidationPrice? }` — deliberately **no numeric
weights**: a model-authored 60% is a pseudo-probability, and this suite's
analyst boundary is report-what-the-data-shows, never forecast-or-recommend.
`stance` labels the primary reading; prices, when present, pass the same range
gate and let cards draw trigger/invalidation lines without parsing prose.

## 5. Client renderer registry (`registryVersion: 1`)

```ts
import { registerAnnotationRenderer } from '@dsh-trading/client-chart/client'

registerAnnotationRenderer('elliott_wave', (annotation, ctx) => [
  { kind: 'polyline', points: [...], label: 'W5', color: ctx.palette.target, dashed: true },
])
```

- A renderer is a **pure function** `(annotation, ctx) => DrawPrimitive[]`
  with `DrawPrimitive = hline {price,label?,color?,dashed?} | region
  {low,high,label?,color?} | polyline {points:[{time,price}],label?,color?,dashed?}`
  and `ctx = {contractVersion, timeframe, close, palette}`. It never touches
  the charting library or the DOM, so it survives chart re-inits (timeframe
  tabs, chip toggles, theme changes) and chart-library upgrades. No cleanup
  hooks exist because none are needed.
- Register inside your client plugin's `apply()`; dsh's HMR fiber cascade
  re-runs it after reloads. Duplicate registration: last wins, logged.
- Mark `@dsh-trading/client-chart` **external** in your bundle and require it
  as `@dsh-trading/client-chart/client` — the dsh module loader resolves
  rostered plugin bundles by package name; bundling a private copy gives you
  a second, empty registry.
- Rendering is best-effort per installed renderer set: a replayed session on
  a host without your renderer shows the textual fallback row instead. The
  durable payload, not the pixels, is the record.

## 6. Deferred (design notes, not yet contracts)

- **Watch/alert**: a `kind:'watch'` payload naming price-cross conditions is
  the sketch; evaluation source, close-vs-tick semantics, delivery
  guarantees, and expiry are unresolved — deliberately unspecified rather
  than specified badly. Whatever lands will be notify-only: execution is
  structurally out of scope and `risk-guard` enforces that at the tool gate.
- **`@dsh-trading/contracts` package**: dependency-free types + validators,
  so server-side tools stop importing a client package for types.
- **Conformance fixtures**: golden payloads + a validate function for
  third-party CI.
