/**
 * One timeframe's indicator regime: the latest value of each dashboard
 * indicator plus a coarse label the model can reason over without re-deriving
 * thresholds. Labels use the conventional bands (RSI 30/70, Stoch 20/80,
 * ADX 20/25, MFI 20/80) — coarse on purpose; nuance belongs to the analyst,
 * not the tool.
 *
 * Every label is derived from the ROUNDED value the snapshot reports, never
 * from the full-precision one behind it, so a label can never contradict the
 * number printed beside it.
 * @module @dsh-trading/tool-market
 */

import type { Candle } from '@dsh-trading/market-data'
import { rsi, sma } from './indicators.js'
import { adx, atr, bollinger, ema, macd, mfi, stochastic } from './candle-indicators.js'

/** Latest defined value of a series, or null when nothing seeded. */
function last(series: readonly (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) return series[i]!
  }
  return null
}

/**
 * Round for reporting. `-0` collapses to `0`: a residue that rounds away to
 * nothing must not keep a sign none of the reported digits can show.
 */
const round = (v: number | null, places = 2): number | null => {
  if (v === null) return null
  const rounded = Number(v.toFixed(places))
  return rounded === 0 ? 0 : rounded
}

function band(value: number | null, low: number, high: number, labels: [string, string, string]): string | null {
  if (value === null) return null
  return value < low ? labels[0] : value > high ? labels[2] : labels[1]
}

/**
 * Which side of its signal the macd line sits on, decided on the same rounded
 * numbers the snapshot reports. A series whose line converges onto its signal
 * (a linear ramp pins the line to a constant the signal EMA reproduces exactly)
 * is equal in real arithmetic and differs only by float residue: that ties at
 * reporting precision and reads 'flat', rather than taking a side from ~1e-15
 * no one can see. 'converging' marks a histogram inside 5% of the line; a flat
 * reading has already arrived, so it carries no tag.
 */
function macdState(line: number, signal: number, histogram: number | null): string {
  if (line === signal) return 'flat'
  const side = line > signal ? 'bullish' : 'bearish'
  return histogram !== null && Math.abs(histogram) < Math.abs(line) * 0.05
    ? `${side}, converging`
    : side
}

/**
 * The per-timeframe regime snapshot the tool returns and renders. A type
 * alias rather than an interface so it stays structurally assignable to the
 * harness's `JsonValue` (interfaces get no implicit index signature), which
 * is what lets the tool return it through a `type: 'json'` output node.
 */
export type RegimeSnapshot = {
  bars: number
  lastTime: string
  close: number
  /** Percent change of the last close vs the previous close. */
  changePct: number | null
  rsi14: { value: number | null; state: string | null }
  stochastic: { k: number | null; d: number | null; state: string | null }
  adx14: { value: number | null; plusDi: number | null; minusDi: number | null; state: string | null }
  /** `state` reads `line` against `signal`: bullish, bearish, or flat when they tie. */
  macd: { line: number | null; signal: number | null; histogram: number | null; state: string | null }
  mfi14: { value: number | null; state: string | null }
  atr14: { value: number | null; pctOfClose: number | null }
  movingAverages: {
    sma20: number | null
    sma50: number | null
    sma200: number | null
    ema20: number | null
    /** Which of the seeded SMAs the close sits above, e.g. `above 20/50, below 200`. */
    closeVs: string
  }
  bollinger20: { upper: number | null; middle: number | null; lower: number | null; state: string | null }
}

/** Compute the full dashboard for one candle series (ascending, as providers serve it). */
export function regimeSnapshot(candles: readonly Candle[]): RegimeSnapshot {
  if (candles.length === 0) throw new Error('regimeSnapshot requires at least one candle')
  const closes = candles.map(c => c.close)
  const latest = candles[candles.length - 1]!
  const prev = candles.length > 1 ? candles[candles.length - 2]!.close : null

  // Rounded once, here: every value below is both what the snapshot reports and
  // what its label is computed from, so the two cannot drift apart.
  const rsiV = round(last(rsi(closes, 14)))
  const { k, d } = stochastic(candles)
  const kV = round(last(k))
  const dV = round(last(d))
  const adxR = adx(candles)
  const adxV = round(last(adxR.adx))
  const macdR = macd(closes)
  const macdLine = round(last(macdR.macd), 4)
  const macdSig = round(last(macdR.signal), 4)
  const macdHist = round(last(macdR.histogram), 4)
  const mfiV = round(last(mfi(candles)))
  const atrV = round(last(atr(candles)), 4)
  const bb = bollinger(closes)
  const bbU = round(last(bb.upper), 4)
  const bbL = round(last(bb.lower), 4)

  const smas: [number, number | null][] = [20, 50, 200].map(w =>
    [w, candles.length >= w ? round(last(sma(closes, w)), 4) : null] as [number, number | null])
  const above = smas.filter(([, v]) => v !== null && latest.close >= v).map(([w]) => w)
  const below = smas.filter(([, v]) => v !== null && latest.close < v).map(([w]) => w)
  const closeVs = [
    above.length > 0 ? `above ${above.join('/')}` : null,
    below.length > 0 ? `below ${below.join('/')}` : null,
  ].filter(Boolean).join(', ') || 'no seeded moving averages'

  return {
    bars: candles.length,
    lastTime: latest.time,
    close: latest.close,
    changePct: prev === null || prev === 0 ? null : round(((latest.close - prev) / prev) * 100),
    rsi14: { value: rsiV, state: band(rsiV, 30, 70, ['oversold', 'neutral', 'overbought']) },
    stochastic: {
      k: kV,
      d: dV,
      state: band(kV, 20, 80, ['oversold', 'neutral', 'overbought']),
    },
    adx14: {
      value: adxV,
      plusDi: round(last(adxR.plusDi)),
      minusDi: round(last(adxR.minusDi)),
      state: band(adxV, 20, 25, ['no trend', 'developing trend', 'trending']),
    },
    macd: {
      line: macdLine,
      signal: macdSig,
      histogram: macdHist,
      state: macdLine === null || macdSig === null
        ? null
        : macdState(macdLine, macdSig, macdHist),
    },
    mfi14: { value: mfiV, state: band(mfiV, 20, 80, ['oversold', 'neutral', 'overbought']) },
    atr14: {
      value: atrV,
      pctOfClose: atrV === null || latest.close === 0 ? null : round((atrV / latest.close) * 100),
    },
    movingAverages: {
      sma20: smas[0]![1],
      sma50: smas[1]![1],
      sma200: smas[2]![1],
      ema20: round(last(ema(closes, 20)), 4),
      closeVs,
    },
    bollinger20: {
      upper: bbU,
      middle: round(last(bb.middle), 4),
      lower: bbL,
      state: bbU === null || bbL === null
        ? null
        : latest.close > bbU ? 'above upper band' : latest.close < bbL ? 'below lower band' : 'inside bands',
    },
  }
}

/** Render one timeframe's snapshot as the compact text block the model reads. */
export function renderSnapshot(timeframe: string, s: RegimeSnapshot): string {
  const fmt = (v: number | null): string => v === null ? '–' : String(v)
  return [
    `[${timeframe}] ${s.bars} bars, last ${s.lastTime}, close ${s.close}${s.changePct !== null ? ` (${s.changePct > 0 ? '+' : ''}${s.changePct}%)` : ''}`,
    `  RSI14 ${fmt(s.rsi14.value)} (${s.rsi14.state ?? '–'}) | Stoch %K ${fmt(s.stochastic.k)} %D ${fmt(s.stochastic.d)} (${s.stochastic.state ?? '–'}) | ADX ${fmt(s.adx14.value)} +DI ${fmt(s.adx14.plusDi)} −DI ${fmt(s.adx14.minusDi)} (${s.adx14.state ?? '–'})`,
    `  MACD ${fmt(s.macd.line)} sig ${fmt(s.macd.signal)} hist ${fmt(s.macd.histogram)} (${s.macd.state ?? '–'}) | MFI ${fmt(s.mfi14.value)} (${s.mfi14.state ?? '–'}) | ATR ${fmt(s.atr14.value)}${s.atr14.pctOfClose !== null ? ` = ${s.atr14.pctOfClose}% of close` : ''}`,
    `  close ${s.movingAverages.closeVs} | SMA20 ${fmt(s.movingAverages.sma20)} SMA50 ${fmt(s.movingAverages.sma50)} SMA200 ${fmt(s.movingAverages.sma200)} EMA20 ${fmt(s.movingAverages.ema20)} | BB(20,2) ${s.bollinger20.state ?? '–'} [${fmt(s.bollinger20.lower)} … ${fmt(s.bollinger20.upper)}]`,
  ].join('\n')
}
