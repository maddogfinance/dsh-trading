# @dsh-trading/verdict

The evaluation harness: deterministic checks over backtest artifacts. The
model proposes results; this plugin disposes of the ones that could not be
true — and refuses to certify the ones the sample cannot support.

LLM coding agents reproduce the leaky backtest tutorials they were trained on
("LLM lookahead bias"): anyone can now produce a professional-looking,
self-deceiving backtest in an afternoon. This package is the detection layer.

## Tools

- **`audit_backtest`** — takes a backtest artifact (see CONTRACTS.md §6),
  fetches the same candles from the mounted market-data provider (window
  padded by whole bars so the first trade's entry bar is never cropped),
  and runs:
  - *Fill validation*: every entry/exit price must sit inside its bar's true
    low..high — a price the bar never printed is a fill that never happened;
    times beyond the data window are flagged, never validated against the
    last bar. Same philosophy as `annotate_chart`'s trust gate. An optional
    `priceTolerancePct` absorbs cross-vendor OHLC disagreement.
  - *Trade independence*: duplicated or overlapping same-side trades
    collapse to effective samples — one lucky trade copied 800 times is one
    observation, not a track record.
  - *Random baseline*: a seeded Monte-Carlo of random-entry twins (same
    bars, holding periods, side mix), ranked against the strategy's
    close-to-close SHADOW returns — optimistic intrabar fill assumptions
    cannot buy a percentile. Results inside the luck distribution get
    NOT PROVEN, whatever the headline return says.
  - *Fill model*: self-reported vs shadow mean return; a material gap means
    the edge lives in fill placement this timeframe cannot verify.
  - *Sample-size power*: can `n` independent trades support the claim on
    BOTH the win-rate and mean-return dimensions? Underpowered means
    NOT PROVEN, not a prettier metric.
  - *Plausibility*: win-rate CIs implausibly close to 100% get named.
  - *Costs*: artifacts that don't declare fees/slippage included are flagged.
- **`lint_strategy_code`** — pattern rules for the classic leaks:
  `shift(-n)`, `rolling(center=True)`, `np.roll(x, -n)`, backfill,
  full-data scaler fits, `lead()`. Hits are suspect constructs to inspect;
  silence is not proof.

## Verdict semantics

`DEFECTS_FOUND` | `NOT_PROVEN` | `NO_DEFECTS_FOUND` — none of these means
"this strategy works". The report says so in its own headline, caps itself
at NOT_PROVEN whenever a substantive check could not run, and ends every
report by naming its own blind spots (in-sample selection, omitted trades,
intrabar fills).

Every check is plain seeded code; identical inputs produce identical
reports, so a session-log replay reproduces the audit exactly. No LLM grades
its own homework here.

## Artifact contract (v1)

```jsonc
{
  "version": 1,
  "symbol": "DEMO-EQ",          // exactly as the provider reports it
  "timeframe": "1d",
  "trades": [{
    "entryTime": "2026-01-02T10:00:00Z",  // any instant inside the entry bar
    "exitTime":  "2026-01-05T14:00:00Z",
    "side": "long",                        // or "short"
    "entryPrice": 100.0,
    "exitPrice": 104.2
  }],
  "costs": { "included": false }           // optional; omit = gross returns
}
```

Canonical copy lives in CONTRACTS.md §6. Additive-only within version 1,
like every dsh-trading contract.

## Boundary

Research only. Verdicts judge evidence quality; nothing here forecasts,
recommends, or trades. Nothing is investment advice.

Both tools read the files they are pointed at (artifact JSON, strategy
sources) from disk as given, relative to the working directory or absolute —
point them only at files you mean to show the model.
