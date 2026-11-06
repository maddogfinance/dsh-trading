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

## 6. Backtest artifact — version 1

The shape `@dsh-trading/verdict`'s `audit_backtest` audits; any engine can
produce it (the planned `@dsh-trading/backtest` and `reference-packs` will).
Additive-only within version 1; readers MUST ignore unknown fields.

```jsonc
{
  "version": 1,
  "symbol": "DEMO-EQ",          // exactly as the provider reports it
  "timeframe": "1d",            // one of the Timeframe values in §1
  "trades": [{
    "entryTime": "2026-01-02T10:00:00Z",  // ISO-8601 UTC, any instant INSIDE the entry bar
    "exitTime":  "2026-01-05T14:00:00Z",
    "side": "long",                        // or "short"
    "entryPrice": 100.0,
    "exitPrice": 104.2
  }],
  "costs": { "included": false },          // optional; omit = gross returns
  "source": { "engine": "my-backtester" }  // optional provenance
}
```

- Per-trade return convention is entry-notional: long `exit/entry - 1`,
  short `(entry - exit)/entry`.
- Producers should emit fills obtainable at the declared timeframe
  (next-bar-open style); `audit_backtest` ranks strategies by close-to-close
  shadow returns and reports self-reported vs shadow as the fill-model gap,
  so optimistic intrabar pricing surfaces instead of scoring.

## 7. Walkthrough payload — `kind: 'walkthrough'`, `version: 1`

One section of an analysis told to the reader on their chart: a few spoken
lines, each moving the chart. Produced by `walkthrough`
(`@dsh-trading/tool-market`, resolver in `src/walkthrough.ts`), carried on the
tool result's `meta` like §2, consumed by the walkthrough card and the chart
column in `@dsh-trading/client-chart`.

```jsonc
{
  "kind": "walkthrough", "version": 1,
  "provider": "public", "symbol": "AAPL", "timeframe": "1d", "section": "双顶",
  "window": { "from": 1791293400000, "to": 1793629800000 },   // bar open times, ms (2026-10-06 → 2026-11-02)
  "pane": "stoch",                                              // optional: rsi|stoch|adx|macd|mfi
  "series": { "t": [/* ms */], "cols": { "stoch_k": [/* … */], "stoch_d": [/* … */] } },
  "marks": [
    { "id": "p1", "type": "circle", "surface": "price", "tone": "neutral", "at": { "t": 1792762200000, "v": 351.73 } },
    { "id": "zone", "type": "zone", "surface": "price", "tone": "neutral", "low": 334.35, "high": 337, "keep": true },
    { "id": "up", "type": "arrow", "surface": "price", "tone": "up", "points": [{ "t": 1793629800000, "v": 338.32 }, { "ahead": 10, "v": 348 }] }
  ],
  "lines": [
    { "say": "[[p1|10/23]] 冲到 351.73，没站住。", "draw": ["p1"], "point": "p1" },
    { "say": "回到我们一开始说的[[zone|那一段]]。", "focus": "zone", "point": "zone", "volume": [1793629800000] }
  ],
  "ask": ["好，你说"],
  "close": 338.32
}
```

- **Anchored, not asserted.** The model names a bar and a field (`{ time,
  field }`); the producer reads the value off the bars and writes the
  resolved `{ t, v }`. A value the model states is checked, and a mismatch
  fails the call with the bar where that value does occur. A level may cite a
  checkable `source` (`{ field, time }`, or `{ field, stat: 'min'|'max',
  from, to }`); without one it needs a free-text `why`. Indicator values are
  computed over the same 300-bar window as `market_snapshot`, so they match
  what the model read.
- **Marks** are `circle` (a bar value), `level`, `zone`, `path`/`arrow`
  (through bars, then optional `ahead` projections), and `span` (a time
  range). `surface` says which pane: `price`, `volume`, or `indicator` (the
  section's `pane`). `keep` leaves a mark faintly on the chart through later
  sections of the same instrument; `focus` on a later line re-lights any
  earlier mark by id.
- **Lines** are text the client renders as text, never HTML. Two inline
  tokens exist: `[[markId|words]]` ties words to a mark (hovering them lights
  it), `**words**` is bold; anything else is literal.
- **Pacing is the reader's, not the producer's.** A section that lands live
  is spoken a line at a time and queues behind the one before it; a section
  from history shows settled. `ask` offers 1–3 replies once every line is
  said, and the turn ends there; a tapped reply is sent as the reader's own
  message.
- `series` columns are keyed by bar time and drawn by time, not position, so
  they land on the right bars of a longer, live series.

## 8. Instrument naming — one symbol, three layers

The reader names an instrument in whatever form they have it: `NVDA`, `腾讯`,
`tengxun`, `台积电`, `US.MU`, `HK.00700`. Three layers turn that into one
symbol, and each owns a different question. Change one without the others and
the column and the model start disagreeing about what is on screen.

**Layer 1 — the column parses the message (`client-chart/src/client/symbols.ts`).**
Pure, synchronous, no network. It answers "is there a symbol in this text?"
and nothing else:

| Kind | What it is | What the caller does |
|---|---|---|
| `symbol` | the text already is one (`NVDA`, `0700.HK`, `BTC-USD`, `^GSPC`, `GC=F`) | load it as written |
| `text` | a run of Chinese, ≤ 10 characters (`腾讯`) | ask the provider; it owns the name table |
| `query` | a lower-case Latin word (`tesla`) | ask the provider, then accept only an exact ticker or a name that is that company |

Broker notation is rewritten on the way out (`US.MU` → `MU`, `HK.00700` →
`0700.HK`, `SH.600519` → `600519.SS`), because a chart that refuses `US.MU`
reads as broken rather than mistranslated. `NOT_TICKERS` is the other half of
this layer: `RSI`, `MACD`, `BUY`, `NOW` and friends are vocabulary, not
instruments, and a request is full of them.

Candidates come back in the order the reader wrote them, and the panel takes the
first that resolves — `先看 NVDA 再看 腾讯` opens NVDA.

**Layer 2 — the provider resolves names (`provider-public.search`).**
`MarketDataProvider.search` is optional; a provider without it answers nothing
and callers fall back to "type the exact ticker". `provider-public` answers in
this order:

1. the catalogue's own symbols and names (`NVDA`, `apple`);
2. a name table carrying Chinese, pinyin and English spellings
   (`腾讯` / `tengxun` / `tencent` → `0700.HK`);
3. the same table by containment, longest name first, so `腾讯怎么样` is about
   腾讯 and `贵州茅台` is not answered as 茅台. Latin names need a word
   boundary, or `gold` fires inside `goldman`;
4. Yahoo's search endpoint, for everything else.

A resolved name keeps the reader's own word, not the catalogue's display name:
callers match a lookup back against what was asked, and `Bitcoin / US Dollar`
is not what anyone typed.

The name table lives here and only here. The client used to keep a second copy,
which drifted; the column now forwards the name instead.

**Layer 3 — the model confirms (`resolve_symbol`, tool-market).**
Same lookup, exposed as a tool. The persona requires it before reading any data
when the reader names an instrument in words, so the model cannot guess a ticker
and then describe the wrong company's bars. It is also what makes a lookup the
model can cite, rather than an assumption.

**What the column does with the answer.** Naming an instrument moves the column
immediately, before the model has said anything. Two rules keep that honest:

- Only messages that were *just* said count (60s), so opening a page onto old
  history does not yank the chart.
- Once the reader has named an instrument, only that instrument may move the
  column until the agent charts it. A turn still running keeps charting the
  symbol it started on, and without this the old analysis drags the column back.

A message sent while a turn is running is not history yet: it waits in the
session's inbox (`queue`) until the agent admits it. The panel reads both the
inbox and the conversation nodes, or the second ticker of a session is invisible
to it.

## 9. Deferred (design notes, not yet contracts)

- **Watch/alert**: a `kind:'watch'` payload naming price-cross conditions is
  the sketch; evaluation source, close-vs-tick semantics, delivery
  guarantees, and expiry are unresolved — deliberately unspecified rather
  than specified badly. Whatever lands will be notify-only: execution is
  structurally out of scope and `risk-guard` enforces that at the tool gate.
- **`@dsh-trading/contracts` package**: dependency-free types + validators,
  so server-side tools stop importing a client package for types.
- **Conformance fixtures**: golden payloads + a validate function for
  third-party CI.
