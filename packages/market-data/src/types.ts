/**
 * The provider-facing vocabulary of the market-data seam. This module is
 * dependency-free on purpose: a provider implements these types and nothing
 * else, so bringing your own data never pulls in harness internals.
 * @module @dsh-trading/market-data
 */

/** Supported bar intervals. Providers may serve a subset. */
export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w'

/** One OHLCV bar. `time` is the bar OPEN time as an ISO-8601 UTC string. */
export interface Candle {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** A tradable instrument as the provider knows it. */
export interface InstrumentInfo {
  /** Provider-scoped symbol, e.g. `AAPL` or `BTC/USDT`. */
  symbol: string
  /** Human-readable name, when the provider has one. */
  name?: string
  /** Free-form asset class tag, e.g. `equity`, `crypto`, `future`. */
  assetClass?: string
  /** Timeframes this provider can serve for the instrument. */
  timeframes?: Timeframe[]
}

/** A candle request. Ranges are ISO-8601 strings; both ends optional. */
export interface OhlcvQuery {
  symbol: string
  timeframe: Timeframe
  /** Inclusive range start (bar open time). Omit for "from the beginning". */
  start?: string
  /** Inclusive range end (bar open time). Omit for "to the latest". */
  end?: string
  /** Max bars returned, counted from the END of the range. */
  limit?: number
}

/**
 * The contract a data source implements. This is the whole BYO surface:
 * CSV files, ClickHouse, a broker API, and CCXT all look identical above
 * this line.
 */
export interface MarketDataProvider {
  /** Registry id, unique per running composition, e.g. `csv`, `ccxt`. */
  readonly id: string
  /** One line shown to users (and models) describing the data source. */
  readonly description: string
  /** Enumerate available instruments. May be expensive; callers cache. */
  listSymbols(): Promise<InstrumentInfo[]>
  /**
   * Serve candles for one query, ascending by time, within [start, end],
   * trimmed to `limit` from the end. Unknown symbols/timeframes throw.
   */
  getOhlcv(query: OhlcvQuery): Promise<Candle[]>
}
