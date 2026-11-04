/**
 * Keyless public-data provider: candles from Yahoo Finance's public chart
 * endpoint. Equities, ETFs, indices, FX, futures and the major crypto pairs all
 * live behind one URL shape, so a demo deployment needs no broker gateway, no
 * API key and no CSV drop.
 *
 * This is a *deployment* provider, not a production feed: Yahoo's endpoint is
 * undocumented, rate-limited and occasionally returns a partial series. Every
 * response is shape-checked and a partial series is refused rather than
 * silently trimmed — the seam's rule is "fail loud on shape drift".
 *
 * The mapping from the seam's `Timeframe` to Yahoo's `interval`/`range` is a
 * deliberate trade: Yahoo caps intraday history (7d for 1m, 60d for 5m–30m,
 * 730d for 60m), so each timeframe asks for the longest window it can serve.
 * `4h` is aggregated locally from `60m` because Yahoo has no 4-hour interval,
 * on the instrument's session grid so that no 4h bar spans two trading days.
 * @module @dsh-trading/provider-public
 */
import z from '@deepseek-ai/schemastery'
import type { Candle, InstrumentInfo, MarketDataProvider, OhlcvQuery, Timeframe } from '@dsh-trading/market-data'

export const name = 'provider-public'
export const inject = ['marketData']

export const Config: z<Config> = z.object({
  id: z.string().default('public'),
  /** Override the chart host, e.g. an egress proxy in a locked-down region. */
  baseURL: z.string().default('https://query1.finance.yahoo.com'),
  /** Cache lifetime for intraday series, in milliseconds. */
  cacheMs: z.number().default(20_000),
  /** Cache lifetime for daily/weekly series, in milliseconds. */
  dailyCacheMs: z.number().default(300_000),
})

export interface Config {
  id: string
  baseURL: string
  cacheMs: number
  dailyCacheMs: number
}

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']

const WINDOWS: Record<Timeframe, { interval: string; range: string; aggregate?: number }> = {
  '1m': { interval: '1m', range: '5d' },
  '5m': { interval: '5m', range: '1mo' },
  '15m': { interval: '15m', range: '1mo' },
  '30m': { interval: '30m', range: '3mo' },
  '1h': { interval: '60m', range: '2y' },
  '4h': { interval: '60m', range: '2y', aggregate: 4 },
  '1d': { interval: '1d', range: '10y' },
  '1w': { interval: '1wk', range: '20y' },
}

const CATALOGUE: InstrumentInfo[] = [
  { symbol: 'BTC-USD', name: 'Bitcoin / US Dollar', assetClass: 'crypto', timeframes: TIMEFRAMES },
  { symbol: 'ETH-USD', name: 'Ethereum / US Dollar', assetClass: 'crypto', timeframes: TIMEFRAMES },
  { symbol: 'SOL-USD', name: 'Solana / US Dollar', assetClass: 'crypto', timeframes: TIMEFRAMES },
  { symbol: 'AAPL', name: 'Apple', assetClass: 'equity', timeframes: TIMEFRAMES },
  { symbol: 'NVDA', name: 'NVIDIA', assetClass: 'equity', timeframes: TIMEFRAMES },
  { symbol: 'MSFT', name: 'Microsoft', assetClass: 'equity', timeframes: TIMEFRAMES },
  { symbol: 'TSLA', name: 'Tesla', assetClass: 'equity', timeframes: TIMEFRAMES },
  { symbol: 'MU', name: 'Micron', assetClass: 'equity', timeframes: TIMEFRAMES },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF', assetClass: 'etf', timeframes: TIMEFRAMES },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', assetClass: 'etf', timeframes: TIMEFRAMES },
  { symbol: '^GSPC', name: 'S&P 500 index', assetClass: 'index', timeframes: TIMEFRAMES },
  { symbol: '^IXIC', name: 'Nasdaq Composite', assetClass: 'index', timeframes: TIMEFRAMES },
  { symbol: 'GC=F', name: 'Gold futures', assetClass: 'future', timeframes: TIMEFRAMES },
  { symbol: 'CL=F', name: 'Crude oil futures', assetClass: 'future', timeframes: TIMEFRAMES },
  { symbol: 'EURUSD=X', name: 'Euro / US Dollar', assetClass: 'fx', timeframes: TIMEFRAMES },
  { symbol: 'JPY=X', name: 'US Dollar / Japanese Yen', assetClass: 'fx', timeframes: TIMEFRAMES },
]

const CRYPTO_ALIASES: Record<string, string> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
  XRP: 'XRP-USD',
  DOGE: 'DOGE-USD',
  ADA: 'ADA-USD',
  BNB: 'BNB-USD',
  AVAX: 'AVAX-USD',
  LINK: 'LINK-USD',
  LTC: 'LTC-USD',
}

/** Normalise the symbols people actually type onto Yahoo's spelling. */
export function normaliseSymbol(raw: string): string {
  let symbol = raw.trim().toUpperCase()
  if (symbol.length === 0) throw new Error('symbol is empty')
  if (symbol.length > 24) throw new Error(`symbol is implausibly long: ${raw}`)
  if (symbol.includes('/')) symbol = symbol.replace('/', '-')
  if (symbol.endsWith('USDT')) symbol = `${symbol.slice(0, -4)}-USD`
  if (CRYPTO_ALIASES[symbol] !== undefined) return CRYPTO_ALIASES[symbol]!
  // Six letters that are two known fiat codes is an FX pair, not a ticker.
  if (/^[A-Z]{6}$/.test(symbol) && isFiatPair(symbol)) return `${symbol}=X`
  return symbol
}

const FIAT = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'CNH', 'HKD', 'SGD', 'SEK', 'NOK', 'MXN', 'ZAR'])

function isFiatPair(symbol: string): boolean {
  return FIAT.has(symbol.slice(0, 3)) && FIAT.has(symbol.slice(3))
}

/** The part of Yahoo's chart `meta` that says when an instrument trades. */
export interface YahooMeta {
  symbol?: string
  /** IANA zone of the listing exchange, e.g. `America/New_York`; `UTC` for crypto. */
  exchangeTimezoneName?: string
  /** Today's (or the next) regular session, in epoch seconds. */
  currentTradingPeriod?: { regular?: { start?: number; end?: number } }
}

interface YahooChart {
  chart?: {
    result?: Array<{
      meta?: YahooMeta
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>
          high?: Array<number | null>
          low?: Array<number | null>
          close?: Array<number | null>
          volume?: Array<number | null>
        }>
      }
    }>
    error?: { code?: string; description?: string } | null
  }
}

class PublicProvider implements MarketDataProvider {
  readonly id: string
  readonly description: string
  private readonly baseURL: string
  private readonly cacheMs: number
  private readonly dailyCacheMs: number
  private readonly cache = new Map<string, { at: number; candles: Candle[] }>()

  constructor(config: Config) {
    this.id = config.id
    this.baseURL = config.baseURL.replace(/\/$/, '')
    this.cacheMs = config.cacheMs
    this.dailyCacheMs = config.dailyCacheMs
    this.description =
      'Public Yahoo Finance candles (equities, ETFs, indices, FX, futures, crypto pairs) — keyless, 1m–1w'
  }

  async listSymbols(): Promise<InstrumentInfo[]> {
    return CATALOGUE
  }

  async getOhlcv(query: OhlcvQuery): Promise<Candle[]> {
    const window = WINDOWS[query.timeframe]
    if (window === undefined) throw new Error(`unsupported timeframe '${query.timeframe}' (have ${TIMEFRAMES.join(', ')})`)
    const symbol = normaliseSymbol(query.symbol)
    const key = `${symbol}|${window.interval}|${window.range}|${window.aggregate ?? 1}`
    const ttl = query.timeframe === '1d' || query.timeframe === '1w' ? this.dailyCacheMs : this.cacheMs
    const hit = this.cache.get(key)
    let candles: Candle[]
    if (hit !== undefined && Date.now() - hit.at < ttl) {
      candles = hit.candles
    } else {
      const series = await this.fetch(symbol, window.interval, window.range)
      const width = INTERVAL_MS[window.interval]
      candles = window.aggregate !== undefined
        ? aggregate(series.candles, window.aggregate, sessionOf(series.meta, symbol))
        : width !== undefined ? foldEchoes(series.candles, width) : series.candles
      this.cache.set(key, { at: Date.now(), candles })
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value as string)
    }
    // Filter, never seek: an older start than the window returns what exists,
    // honestly, rather than pretending to have the full range.
    if (query.start !== undefined) {
      const start = Date.parse(query.start)
      if (Number.isNaN(start)) throw new Error(`invalid start '${query.start}'`)
      candles = candles.filter(c => Date.parse(c.time) >= start)
    }
    if (query.end !== undefined) {
      const end = Date.parse(query.end)
      if (Number.isNaN(end)) throw new Error(`invalid end '${query.end}'`)
      candles = candles.filter(c => Date.parse(c.time) <= end)
    }
    if (query.limit !== undefined && candles.length > query.limit) candles = candles.slice(-query.limit)
    return candles
  }

  private async fetch(symbol: string, interval: string, range: string): Promise<{ candles: Candle[]; meta: YahooMeta | undefined }> {
    const url = new URL(`${this.baseURL}/v8/finance/chart/${encodeURIComponent(symbol)}`)
    url.searchParams.set('interval', interval)
    url.searchParams.set('range', range)
    url.searchParams.set('includePrePost', 'false')
    url.searchParams.set('events', 'div,splits')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    let response: Response
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; dsh-trading/0.2; +https://github.com/maddogfinance/dsh-trading)',
          accept: 'application/json',
        },
      })
    } catch (error) {
      throw new Error(`Yahoo request failed for ${symbol} ${interval}/${range}: ${(error as Error).message}`)
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) throw new Error(`Yahoo returned HTTP ${response.status} for ${symbol} ${interval}/${range}`)
    const body = (await response.json()) as YahooChart
    const failure = body.chart?.error
    if (failure !== undefined && failure !== null) {
      throw new Error(`Yahoo has no data for '${symbol}': ${failure.description ?? failure.code ?? 'unknown error'}`)
    }
    const result = body.chart?.result?.[0]
    const timestamps = result?.timestamp
    const quote = result?.indicators?.quote?.[0]
    if (result === undefined || timestamps === undefined || quote === undefined) {
      throw new Error(`Yahoo returned no series for '${symbol}' ${interval}/${range}`)
    }
    const candles: Candle[] = []
    for (let i = 0; i < timestamps.length; i += 1) {
      const open = quote.open?.[i]
      const high = quote.high?.[i]
      const low = quote.low?.[i]
      const close = quote.close?.[i]
      const volume = quote.volume?.[i] ?? 0
      // Yahoo pads holidays and halted sessions with nulls; skip only those.
      if (open == null || high == null || low == null || close == null) continue
      if (![open, high, low, close, volume].every(v => Number.isFinite(v))) continue
      const time = new Date(timestamps[i]! * 1000).toISOString()
      candles.push({ time, open, high, low, close, volume })
    }
    if (candles.length === 0) throw new Error(`Yahoo series for '${symbol}' ${interval}/${range} is empty`)
    return { candles: candles.sort((a, b) => Date.parse(a.time) - Date.parse(b.time)), meta: result.meta }
  }
}

/** The grid aggregated bars sit on: blocks step from a local open time in one zone. */
export interface Session {
  /** IANA zone the open is read in. */
  timeZone: string
  /** Minutes after local midnight at which each day's first block opens. */
  openMinute: number
}

/** Markets that trade round the clock: blocks open at 00, 04, 08, 12, 16 and 20 UTC. */
export const UTC_GRID: Session = { timeZone: 'UTC', openMinute: 0 }

/** A regular period at least this long (seconds) is a market that never closes for the day. */
const ROUND_THE_CLOCK = 20 * 3600
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/**
 * Read the grid a series' 4h bars sit on from Yahoo's chart meta. A regular
 * session shorter than a day (US equities, ETFs and indices trade 09:30–16:00
 * New York) anchors blocks at its open in the exchange's zone. Crypto trades
 * 24/7, and Yahoo reports FX and CME futures as ~24h periods too; those get the
 * UTC grid. Missing meta fails loud rather than guessing a grid.
 */
export function sessionOf(meta: YahooMeta | undefined, symbol: string): Session {
  const timeZone = meta?.exchangeTimezoneName
  const start = meta?.currentTradingPeriod?.regular?.start
  const end = meta?.currentTradingPeriod?.regular?.end
  if (typeof timeZone !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
    throw new Error(`Yahoo returned no trading period for '${symbol}'; cannot place its 4h bars on session boundaries`)
  }
  if (end - start >= ROUND_THE_CLOCK) return UTC_GRID
  const wall = start * 1000 + zoneOffsetMs(start * 1000, timeZone)
  return { timeZone, openMinute: Math.round((wall - Math.floor(wall / DAY_MS) * DAY_MS) / 60_000) }
}

/**
 * Fold hourly bars into `hours`-wide blocks on a session grid. Each local day's
 * blocks step from the session open (US equities get 09:30–13:30 and
 * 13:30–16:00 New York, round-the-clock markets the UTC grid), so a block never
 * mixes two dates. A block is timed at its start, not at its first bar, and
 * keeps first open, max high, min low, last close and summed volume.
 *
 * Yahoo also echoes prices as flat, zero-volume bars: the 16:00 New York tick
 * that closes the latest session (carrying the official close), a tick at the
 * latest trade, placeholders through some holidays. Folded into a block an echo
 * can move its close, but an echo never opens a block of its own.
 * @param candles - hourly bars, ascending.
 * @param hours - block width; 24 must be a multiple of it.
 * @param session - the grid, from {@link sessionOf}.
 */
export function aggregate(candles: Candle[], hours: number, session: Session): Candle[] {
  const width = hours * HOUR_MS
  const opens = new Map<number, number>()
  const out: Candle[] = []
  let block: Candle | undefined
  let blockStart = Number.NaN
  for (const bar of candles) {
    const t = Date.parse(bar.time)
    const open = sessionOpen(t, session, opens)
    const start = open + Math.floor((t - open) / width) * width
    if (block !== undefined && start === blockStart) {
      block.high = Math.max(block.high, bar.high)
      block.low = Math.min(block.low, bar.low)
      block.close = bar.close
      block.volume += bar.volume
    } else if (!isEcho(bar)) {
      block = { time: new Date(start).toISOString(), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }
      blockStart = start
      out.push(block)
    }
  }
  return out
}

/** Width of Yahoo's intraday intervals; daily and weekly bars carry no echoes worth folding. */
const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '60m': HOUR_MS,
}

/**
 * Keep Yahoo's echoes out of an intraday series. An echo that lands inside the
 * previous bar's interval (the 16:00 closing tick after the 15:30 bar, the live
 * tick at 09:22:56 after the 09:00 bar) is folded into that bar's close; one
 * that would stand as a bar of its own (a holiday placeholder) is dropped.
 * @param candles - bars, ascending.
 * @param width - the interval, in ms.
 */
export function foldEchoes(candles: Candle[], width: number): Candle[] {
  const out: Candle[] = []
  for (const bar of candles) {
    if (!isEcho(bar)) {
      out.push(bar)
      continue
    }
    const last = out[out.length - 1]
    if (last === undefined || Date.parse(bar.time) >= Date.parse(last.time) + width) continue
    out[out.length - 1] = { ...last, high: Math.max(last.high, bar.close), low: Math.min(last.low, bar.close), close: bar.close }
  }
  return out
}

/** A flat, zero-volume bar: Yahoo repeating a price, not a trade. */
function isEcho(bar: Candle): boolean {
  return bar.volume === 0 && bar.open === bar.high && bar.high === bar.low && bar.low === bar.close
}

/**
 * The session open on the local date of instant `t`, in epoch ms. Memoised per
 * local date, since every bar of a day shares it.
 */
function sessionOpen(t: number, session: Session, memo: Map<number, number>): number {
  const midnight = Math.floor((t + zoneOffsetMs(t, session.timeZone)) / DAY_MS) * DAY_MS
  let open = memo.get(midnight)
  if (open === undefined) {
    const wall = midnight + session.openMinute * 60_000
    // Two passes because the offset depends on the instant being solved for.
    const once = wall - zoneOffsetMs(wall, session.timeZone)
    open = wall - zoneOffsetMs(once, session.timeZone)
    memo.set(midnight, open)
  }
  return open
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>()

/**
 * Offset of a zone from UTC at an instant, in ms (New York in winter: -5h).
 * Derived from `Intl` rather than a table so DST is the platform's problem.
 */
function zoneOffsetMs(ms: number, timeZone: string): number {
  if (timeZone === 'UTC') return 0
  let format = zoneFormats.get(timeZone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    zoneFormats.set(timeZone, format)
  }
  const parts = format.formatToParts(ms)
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(p => p.type === type)?.value)
  // Read the zone's wall clock back as if it were UTC; the difference is the offset.
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wall - Math.floor(ms / 1000) * 1000
}

export function apply(ctx: { marketData: { register(provider: MarketDataProvider): () => void }; effect(run: () => () => void): void }, config: Config): void {
  ctx.effect(() => ctx.marketData.register(new PublicProvider(config)))
}
