/**
 * BYO provider: live candles from a local Futu OpenD, for HK / US / A-share
 * equities and crypto pairs. Same seam as `provider-csv` — swap the `market-data-provider` row
 * to this package and every tool upstream is unchanged.
 *
 * Two limits are inherent to the data path and are stated rather than hidden:
 *
 *  - **Recent bars only.** This provider seeds each series from `Qot_GetKL`,
 *    which serves the most recent bars (≤1000) and cannot address an arbitrary
 *    historical window. `OhlcvQuery.start` / `end` therefore FILTER what was
 *    fetched; they do not seek. A range older than the returned window comes
 *    back empty — honestly empty, not silently substituted with the wrong bars.
 *
 *  - **Live by push, not by polling.** Once a series is seeded it is kept
 *    current by Futu's `Qot_UpdateKL` push, and `getOhlcv` answers from that
 *    warm copy. This is Futu's own guidance — GetKL is the snapshot, the push
 *    is the feed — and it means a chart refreshing every second costs the
 *    account nothing: no request per refresh, no quota, no rate limit. A UI
 *    can read as fast as it likes.
 *  - **Configured universe.** OpenD has no cheap "list everything" call and
 *    Futu covers six figures of instruments, so `listSymbols` returns the
 *    symbols this row was configured with rather than dumping a catalogue
 *    into a model's context.
 *
 * OpenD is a personal, account-bound gateway: fine for your own desk, not a
 * redistribution licence. Serving this data onward to other people is a
 * licensing question, not a configuration one.
 * @module @dsh-trading/provider-futu
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Candle, InstrumentInfo, MarketDataProvider, OhlcvQuery } from '@dsh-trading/market-data'
import { mergeBars, toCandles } from './candles.js'
import type { FutuKLine } from './candles.js'
import { OpenDSession, seriesKeyOf } from './opend.js'
import { resolveSymbol, resolveTimeframe, SUPPORTED_TIMEFRAMES } from './protocol.js'

export { probe, unreachableMessage } from './opend.js'
export { describeVersionSkew, parseSdkVersion, resolveSymbol, resolveTimeframe, SUPPORTED_TIMEFRAMES } from './protocol.js'
export type { OpenDVersion } from './protocol.js'
export { toCandle, toCandles, wallClockToEpochMs } from './candles.js'

export const name = 'provider-futu'
export const inject = ['marketData']

/** OpenD's own cap on one `Qot_GetKL` read. */
const MAX_BARS = 1000

export interface Config {
  /** Symbols this row serves, in Futu notation: `HK.00700`, `US.AAPL`, `SH.600519`, `CC.BTCUSDT`. */
  symbols: string[]
  /** OpenD host. */
  host?: string
  /** OpenD **websocket** port — not `api_port` (11111), which speaks TCP protobuf. */
  port?: number
  /** Whether OpenD's websocket listener uses SSL. */
  ssl?: boolean
  /** Websocket key, when OpenD is configured to require one. */
  key?: string
  /** Bars fetched per read; OpenD caps this at 1000. */
  bars?: number
  /** Registry id of this mount. */
  id?: string
}

export const Config: z<Config> = z.object({
  symbols: z.array(z.string()).default([]),
  host: z.string().default('127.0.0.1'),
  port: z.number().default(33333),
  ssl: z.boolean().default(false),
  key: z.string(),
  bars: z.number().default(MAX_BARS),
  id: z.string().default('futu'),
})

class FutuProvider implements MarketDataProvider {
  readonly description: string
  readonly #session: OpenDSession
  readonly #symbols: string[]
  readonly #bars: number
  /** Warm series per subscribed (security, klType): seeded by GetKL, kept current by pushes. */
  readonly #series = new Map<string, Candle[]>()
  #detachPush: (() => void) | undefined

  constructor(
    readonly id: string,
    config: Required<Pick<Config, 'symbols' | 'host' | 'port' | 'ssl' | 'bars'>> & { key?: string | undefined },
    onWarning?: (message: string) => void,
  ) {
    this.#session = new OpenDSession({
      host: config.host,
      port: config.port,
      ssl: config.ssl,
      key: config.key,
      loginTimeoutMs: 10_000,
      onWarning,
    })
    this.#symbols = config.symbols
    this.#bars = Math.min(Math.max(1, Math.trunc(config.bars)), MAX_BARS)
    this.description =
      `Futu OpenD at ${config.host}:${config.port} — live HK/US/A-share/crypto candles, ` +
      `most recent ${this.#bars} bars per timeframe (no historical range seek)`

    // One push listener for the whole provider: it folds every pushed bar into
    // whichever warm series owns it, so reads never wait on the network.
    this.#detachPush = this.#session.onKLine((key, bars) => {
      const series = this.#series.get(key)
      if (series === undefined) return
      // The push carries the instrument's own timezone implicitly; the cached
      // series was normalised with it, and `toCandles` prefers the wire epoch,
      // so the zone argument only matters for the pre-epoch fallback path.
      const fresh = toCandles(bars as FutuKLine[], 'UTC')
      if (fresh.length === 0) return
      this.#series.set(key, mergeBars(series, fresh))
    })
  }

  async listSymbols(): Promise<InstrumentInfo[]> {
    return this.#symbols.map(symbol => {
      const { assetClass } = resolveSymbol(symbol)
      return { symbol, assetClass, timeframes: [...SUPPORTED_TIMEFRAMES] }
    })
  }

  async getOhlcv(query: OhlcvQuery): Promise<Candle[]> {
    const { market, code, timeZone } = resolveSymbol(query.symbol)
    const { klType, subType } = resolveTimeframe(query.timeframe)
    const key = seriesKeyOf(market, code, klType)

    await this.#session.subscribe(market, code, subType)

    // Seed once from the snapshot; after that the push keeps it current and a
    // read costs nothing. Without this the panel's live refresh would spend a
    // Futu request per tick, which is exactly what the push exists to avoid.
    let candles = this.#series.get(key)
    if (candles === undefined) {
      const { klList } = await this.#session.getKL(market, code, klType, this.#bars)
      candles = toCandles(klList as FutuKLine[], timeZone)
      this.#series.set(key, candles)
    }
    if (query.start !== undefined) {
      const start = Date.parse(query.start)
      candles = candles.filter(c => Date.parse(c.time) >= start)
    }
    if (query.end !== undefined) {
      const end = Date.parse(query.end)
      candles = candles.filter(c => Date.parse(c.time) <= end)
    }
    if (query.limit !== undefined && candles.length > query.limit) {
      candles = candles.slice(-query.limit)
    }
    return candles
  }

  close(): void {
    this.#detachPush?.()
    this.#detachPush = undefined
    this.#series.clear()
    this.#session.close()
  }
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('provider-futu')
  const provider = new FutuProvider(config.id ?? 'futu', {
    symbols: config.symbols ?? [],
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 33333,
    ssl: config.ssl ?? false,
    key: config.key,
    bars: config.bars ?? MAX_BARS,
  }, message => logger.warn(message))
  // Tie both the registration and the socket to this plugin's fiber: unloading
  // the row unmounts the provider AND drops the OpenD connection.
  ctx.effect(() => {
    const unregister = ctx.marketData.register(provider)
    return () => {
      unregister()
      provider.close()
    }
  })
}
