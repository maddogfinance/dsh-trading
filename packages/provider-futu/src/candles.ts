/**
 * KLine → Candle normalisation. Pure, and the single place a Futu wire value
 * becomes a number the indicator library will read.
 * @module
 */

import type { Candle } from '@dsh-trading/market-data'

/** The subset of `Qot_Common.KLine` this provider reads. */
export interface FutuKLine {
  /** Exchange wall clock, `yyyy-MM-dd HH:mm:ss` — NOT UTC. */
  time?: string | null
  /** Unix seconds. Present on modern OpenD; the reason we rarely parse `time`. */
  timestamp?: number | null
  openPrice?: number | null
  highPrice?: number | null
  lowPrice?: number | null
  closePrice?: number | null
  /** int64 — protobufjs hands these back as Long objects or strings, not numbers. */
  volume?: number | string | { toString(): string } | null
  /** Turnover (cash traded). Zero alongside zero volume means no trade happened. */
  turnover?: number | null
  /** A blank bar: the exchange was closed / the instrument did not trade. */
  isBlank?: boolean | null
}

/**
 * Whether a KLine represents no trading at all.
 *
 * Futu emits a placeholder bar for a session that has not started yet — during
 * the HK lunch break the afternoon's first bar arrives with `isBlank: false`,
 * zero volume, zero turnover, and the previous close repeated into all four
 * prices. Drawn, it becomes a flat doji at the right edge and makes a stale
 * price look live. It is not a bar; it is a promise of one.
 *
 * All four conditions are required together on purpose: an index has zero
 * volume every bar but real OHLC movement, and a thin equity can trade once
 * and print a flat bar with real volume. Only the conjunction is unambiguous.
 */
function isUntraded(kl: FutuKLine): boolean {
  const v = kl.volume === null || kl.volume === undefined ? 0 : Number(kl.volume.toString())
  if (v !== 0) return false
  if ((kl.turnover ?? 0) !== 0) return false
  const { openPrice: o, highPrice: h, lowPrice: l, closePrice: c } = kl
  return o != null && o === h && o === l && o === c
}

/**
 * Offset of a zone from UTC at a given instant, in ms. Derived from `Intl`
 * rather than a table so DST is the platform's problem, not ours.
 */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? '0')
  // Re-read the wall clock the zone shows, as if it were UTC; the difference is the offset.
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return asUtc - utcMs
}

/**
 * Convert an exchange wall clock to a UTC instant. Two passes because the
 * offset itself depends on the instant: the first pass lands near the right
 * moment, the second fixes the DST-transition hour.
 * @param wallClock - `yyyy-MM-dd HH:mm:ss` as the exchange prints it.
 * @param timeZone - IANA zone of that exchange.
 * @returns epoch ms.
 */
export function wallClockToEpochMs(wallClock: string, timeZone: string): number {
  const asIfUtc = Date.parse(`${wallClock.trim().replace(' ', 'T')}Z`)
  if (Number.isNaN(asIfUtc)) throw new Error(`unparsable Futu time '${wallClock}'`)
  const once = asIfUtc - zoneOffsetMs(asIfUtc, timeZone)
  return asIfUtc - zoneOffsetMs(once, timeZone)
}

/** Coerce a protobuf int64 (Long | string | number) to a finite number. */
function toNumber(value: FutuKLine['volume']): number {
  if (value === null || value === undefined) return 0
  const n = typeof value === 'number' ? value : Number(value.toString())
  return Number.isFinite(n) ? n : 0
}

/**
 * Normalise one KLine. Prefers the wire's `timestamp` (unambiguous epoch
 * seconds) and only falls back to parsing the exchange wall clock — Futu
 * prints HK/A-share bars in Beijing time and US bars in New York time, so a
 * naive parse of `time` silently shifts every bar by hours.
 *
 * @param kl - one wire KLine.
 * @param timeZone - the instrument's exchange zone, used only by the fallback.
 * @returns the seam's candle, or null for a blank or untraded placeholder bar.
 */
export function toCandle(kl: FutuKLine, timeZone: string): Candle | null {
  if (kl.isBlank === true) return null
  if (isUntraded(kl)) return null

  let epochMs: number
  if (typeof kl.timestamp === 'number' && Number.isFinite(kl.timestamp) && kl.timestamp > 0) {
    epochMs = Math.round(kl.timestamp * 1000)
  } else if (typeof kl.time === 'string' && kl.time !== '') {
    epochMs = wallClockToEpochMs(kl.time, timeZone)
  } else {
    throw new Error('Futu KLine carries neither timestamp nor time')
  }

  const open = kl.openPrice ?? null
  const high = kl.highPrice ?? null
  const low = kl.lowPrice ?? null
  const close = kl.closePrice ?? null
  if ([open, high, low, close].some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error(`Futu KLine at ${new Date(epochMs).toISOString()} has a non-numeric OHLC field`)
  }

  return {
    time: new Date(epochMs).toISOString(),
    open: open as number,
    high: high as number,
    low: low as number,
    close: close as number,
    volume: toNumber(kl.volume),
  }
}

/**
 * Normalise a KLine list into ascending candles, dropping blank bars.
 * @param list - the wire `klList`.
 * @param timeZone - the instrument's exchange zone.
 * @returns candles ascending by time.
 */
export function toCandles(list: readonly FutuKLine[], timeZone: string): Candle[] {
  const candles: Candle[] = []
  for (const kl of list) {
    const candle = toCandle(kl, timeZone)
    if (candle !== null) candles.push(candle)
  }
  candles.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  return candles
}

/**
 * Fold freshly pushed bars into a cached series, keyed by open time: a bar
 * that is still forming replaces its earlier self, a bar that has just opened
 * is appended.
 *
 * The same distinction the browser makes, made again here because the warm
 * series is what every consumer now reads — get it wrong and `market_snapshot`
 * hands the model a duplicated candle, which is far worse than a wobbly chart.
 *
 * @param series - the cached ascending candles.
 * @param fresh - pushed bars, any order.
 * @returns the merged series, ascending; the original reference when nothing moved.
 */
export function mergeBars(series: readonly Candle[], fresh: readonly Candle[]): Candle[] {
  if (fresh.length === 0) return series as Candle[]
  const byTime = new Map(series.map(c => [c.time, c]))
  let changed = false
  for (const bar of fresh) {
    const existing = byTime.get(bar.time)
    if (
      existing === undefined
      || existing.open !== bar.open || existing.high !== bar.high
      || existing.low !== bar.low || existing.close !== bar.close || existing.volume !== bar.volume
    ) changed = true
    byTime.set(bar.time, bar)
  }
  if (!changed) return series as Candle[]
  return [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
}
