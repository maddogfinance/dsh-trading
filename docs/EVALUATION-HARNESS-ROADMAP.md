# Evaluation harness roadmap — the back half of dsh-trading

*Status: living document. Added 2026-08-19 alongside `@dsh-trading/verdict` 0.1.0.*

## Why

dsh-trading's front half helps an agent **read** a market (data seam,
deterministic indicators, trust-gated charts). The back half judges what the
agent **concluded**. The gap it fills, in the words of the people who asked
for it:

> "have a prebuilt pipeline where I toss in alpha ideas and end up with robust
> test results at the end... I will need a meta-dashboard meaning I can
> quickly verify nothing was hallucinated" — r/algotrading, 2026-05

> "do you have a simple strategy with its backtest metrics that I can use to
> check my data and backtest harnesses?" — YouTube comment, 2026-08-14

LLM coding agents reproduce the leaky backtest tutorials they were trained
on ("LLM lookahead bias"). The result: anyone can now produce a
professional-looking, self-deceiving backtest in an afternoon. The ability to
manufacture the illusion was democratized; the ability to detect it was not.
That detection layer is this roadmap.

## Principles (inherited from the front half)

1. **Deterministic, never LLM-graded.** Every check is plain code with a
   fixed seed; identical inputs produce identical reports. "Don't let one AI
   grade its own homework."
2. **The harness can say NOT PROVEN.** Underpowered samples get an honest
   verdict, not a prettier metric.
3. **Research only.** Verdicts judge evidence quality. Nothing here places
   orders, forecasts, or recommends.
4. **Host-agnostic core, thin shells.** Pure functions first; the dsh plugin
   is one shell. A Claude Code skill shell over the same lib is planned —
   the harness must not marry any single agent host.

## Package map

| package | role | status |
|---|---|---|
| `@dsh-trading/verdict` | the auditor: lookahead lint, fill validation, random baseline, sample-size power, verdict report | **0.1.0 (this release)** |
| `@dsh-trading/backtest` | deterministic backtest engine: explicit fill semantics (next-bar-open default), cost model, walk-forward/OOS splits as first-class citizens | planned |
| `@dsh-trading/reference-packs` | published reference strategies + metrics so users can calibrate their own harness; also the container for public audit articles (each audit = a pack = a live demo) | planned |
| `client-chart` verdict card | render `VerdictReport` as an interactive card (the "meta-dashboard") | planned |

## Verdict semantics (frozen intent)

Three outcomes, none of which is "this strategy works":

- `DEFECTS_FOUND` — at least one check found a defect (leak, impossible fill).
- `NOT_PROVEN` — no defect, but the evidence cannot distinguish skill from
  luck (underpowered n, or results within the random-baseline distribution).
- `NO_DEFECTS_FOUND` — the artifact survives every check at its sample size.
  Explicitly **not** a certification of profitability; the report says so.

## Near-term sequence

1. `verdict` 0.1: three checkers + report (shipped with this doc).
2. First reference pack: a public audit of a widely-claimed setup
   (candidates: ICT killzone/time-window claims on ES; the Market Profile
   "80% rule") — produced *by* the harness, published *with* the harness.
3. `backtest` MVP with next-bar-open fills and cost model, so `verdict` can
   audit artifacts it produced end-to-end.
4. Claude Code skill shell over the same core.
