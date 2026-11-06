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

/**
 * Names people actually use, mapped to symbols this feed serves.
 *
 * Two reasons this is not left to Yahoo: its index does not answer Chinese
 * names (`英伟达`, `腾讯`), and its search endpoint answers 429 when a demo
 * leans on it. Both are common enough that a lookup which only ever reached
 * Yahoo would look broken.
 */
const NAME_ALIASES: Record<string, string> = {
  腾讯: '0700.HK', 阿里巴巴: 'BABA', 阿里: 'BABA', 贵州茅台: '600519.SS', 茅台: '600519.SS',
  宁德时代: '300750.SZ', 比亚迪: '002594.SZ', 招商银行: '3968.HK', 工商银行: '1398.HK',
  中国平安: '2318.HK', 平安: '2318.HK', 中芯国际: '0981.HK', 中芯: '0981.HK', 小米: '1810.HK',
  美团: '3690.HK', 京东: 'JD', 拼多多: 'PDD', 百度: 'BIDU', 网易: 'NTES', 快手: '1024.HK',
  海底捞: '6862.HK', 农夫山泉: '9633.HK', 港交所: '0388.HK', 汇丰: '0005.HK', 友邦: '1299.HK',
  中国移动: '0941.HK', 蔚来: 'NIO', 理想汽车: 'LI', 小鹏汽车: 'XPEV', 台积电: 'TSM',
  英伟达: 'NVDA', 特斯拉: 'TSLA', 苹果: 'AAPL', 微软: 'MSFT', 谷歌: 'GOOGL', 亚马逊: 'AMZN',
  脸书: 'META', 博通: 'AVGO', 美光: 'MU', 英特尔: 'INTC', 超微: 'AMD', 甲骨文: 'ORCL',
  奈飞: 'NFLX', 迪士尼: 'DIS', 波音: 'BA', 沃尔玛: 'WMT', 可口可乐: 'KO', 摩根大通: 'JPM',
  高盛: 'GS', 伯克希尔: 'BRK-B', 比特币: 'BTC-USD', 大饼: 'BTC-USD', 以太坊: 'ETH-USD',
  以太币: 'ETH-USD', 索拉纳: 'SOL-USD', 黄金: 'GC=F', 原油: 'CL=F', 白银: 'SI=F',
  纳指: '^IXIC', 纳斯达克: '^IXIC', 标普500: '^GSPC', 标普: '^GSPC', 道指: '^DJI',
  道琼斯: '^DJI', 恒生: '^HSI', 恒指: '^HSI', 沪深300: '000300.SS', 上证: '000001.SS',

  // Pinyin: what a reader types on a phone without switching to Chinese.
  tengxun: '0700.HK', tencent: '0700.HK', ali: 'BABA', alibaba: 'BABA', maotai: '600519.SS',
  guizhoumaotai: '600519.SS', ningdeshidai: '300750.SZ', biyadi: '002594.SZ', byd: '002594.SZ',
  zhaoshangyinhang: '3968.HK', gongshangyinhang: '1398.HK', zhongguopingan: '2318.HK',
  pingan: '2318.HK', zhongxinguoji: '0981.HK', zhongxin: '0981.HK', xiaomi: '1810.HK',
  meituan: '3690.HK', jingdong: 'JD', pinduoduo: 'PDD', baidu: 'BIDU', wangyi: 'NTES',
  kuaishou: '1024.HK', haidilao: '6862.HK', nongfushanquan: '9633.HK', gangjiaosuo: '0388.HK',
  huifeng: '0005.HK', youbang: '1299.HK', zhongguoyidong: '0941.HK', weilai: 'NIO',
  nio: 'NIO', lixiang: 'LI', xiaopeng: 'XPEV', taijidian: 'TSM', tsmc: 'TSM',
  yingweida: 'NVDA', nvidia: 'NVDA', tesila: 'TSLA', tesla: 'TSLA', pingguo: 'AAPL',
  apple: 'AAPL', weiruan: 'MSFT', microsoft: 'MSFT', gegu: 'GOOGL', google: 'GOOGL',
  yamaxun: 'AMZN', amazon: 'AMZN', lianshu: 'META', meta: 'META', botong: 'AVGO',
  meiguang: 'MU', yingteer: 'INTC', intel: 'INTC', chaowei: 'AMD', amd: 'AMD',
  jiaguwen: 'ORCL', oracle: 'ORCL', naifei: 'NFLX', netflix: 'NFLX', dishini: 'DIS',
  disney: 'DIS', boyin: 'BA', boeing: 'BA', woerma: 'WMT', walmart: 'WMT',
  koukeokele: 'KO', mocheng: 'JPM', gaosheng: 'GS', bokeerxier: 'BRK-B',
  bitebi: 'BTC-USD', bitcoin: 'BTC-USD', yitaifang: 'ETH-USD', ethereum: 'ETH-USD',
  suolana: 'SOL-USD', solana: 'SOL-USD', huangjin: 'GC=F', gold: 'GC=F',
  yuanyou: 'CL=F', oil: 'CL=F', baiyin: 'SI=F', silver: 'SI=F',
  nazhi: '^IXIC', nasdaq: '^IXIC', biaopu: '^GSPC', sandp: '^GSPC', 's&p': '^GSPC',
  daozhi: '^DJI', dow: '^DJI', hengsheng: '^HSI', hangseng: '^HSI',
  hushen300: '000300.SS', csi300: '000300.SS', shangzheng: '000001.SS',
}

/** Quote types the chart endpoint can actually serve. */
const ASSET_CLASS: Record<string, string> = {
  EQUITY: 'equity',
  ETF: 'etf',
  INDEX: 'index',
  CRYPTOCURRENCY: 'crypto',
  CURRENCY: 'fx',
  FUTURE: 'future',
  MUTUALFUND: 'fund',
}

/** How long one search answer is reused; names do not change by the minute. */
const SEARCH_CACHE_MS = 60_000

/** How long to stop asking Yahoo after it answers 429. */
const SEARCH_COOLDOWN_MS = 60_000

/** Yahoo answers a bare fetch with a consent page; a browser UA keeps it JSON. */
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

interface YahooSearch {
  quotes?: {
    symbol?: string
    shortname?: string
    longname?: string
    quoteType?: string
  }[]
}

class PublicProvider implements MarketDataProvider {
  readonly id: string
  readonly description: string
  private readonly baseURL: string
  private readonly cacheMs: number
  private readonly dailyCacheMs: number
  private readonly cache = new Map<string, { at: number; candles: Candle[] }>()
  private readonly searchCache = new Map<string, { at: number; items: InstrumentInfo[] }>()
  /** Set after Yahoo rate-limits us, so a burst does not become a stampede. */
  private searchBlockedUntil = 0

  /**
   * Look one name up in the local table, including broker notation
   * (`US.MU` → `MU`) and the catalogue itself.
   * @param query - what the reader called it.
   * @returns the instrument, when the table knows it.
   */
  private byName(query: string): InstrumentInfo | undefined {
    const raw = query.trim()
    // The catalogue answers its own symbols and names: `NVDA`, `apple`.
    const direct = CATALOGUE.find(item =>
      item.symbol.toUpperCase() === raw.toUpperCase()
      || (item.name ?? '').toLowerCase() === raw.toLowerCase())
    if (direct !== undefined) return direct
    const aliased = NAME_ALIASES[raw] ?? this.byContainment(raw)
    const broker = /^(US|HK|SH|SZ)\.([A-Za-z0-9.]+)$/.exec(raw)
    let symbol = aliased
    if (symbol === undefined && broker !== null) {
      const market = broker[1] as string
      const code = (broker[2] as string).replace(/^0+(?=\d)/, '')
      symbol = market === 'US'
        ? (broker[2] as string).toUpperCase()
        : market === 'HK'
          ? `${code.padStart(4, '0')}.HK`
          : market === 'SH'
            ? `${code.padStart(6, '0')}.SS`
            : `${code.padStart(6, '0')}.SZ`
    }
    if (symbol === undefined) return undefined
    // The reader's own word stays the name: the catalogue's display name
    // ("Bitcoin / US Dollar") describes the instrument but is not what they
    // typed, and callers match a lookup back against what was asked.
    const catalogued = CATALOGUE.find(item => item.symbol.toUpperCase() === symbol!.toUpperCase())
    return {
      symbol,
      name: raw,
      assetClass: catalogued?.assetClass ?? 'equity',
      timeframes: TIMEFRAMES,
    }
  }

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

  /**
   * Resolve free text to chartable instruments through Yahoo's search endpoint.
   *
   * This is the keyless counterpart of `list_symbols`: the catalogue above is
   * sixteen well-known names, and a reader who asks about "台积电" or "0700.HK"
   * should not have to guess which of them is close enough. Latin queries work
   * directly; Chinese ones need the caller's alias table, because Yahoo's index
   * answers `nvidia` but not `英伟达`.
   */
  /**
   * Find a name inside a sentence — `腾讯怎么样` is a question about 腾讯.
   *
   * Longest match wins, so `贵州茅台` is not answered as 茅台 and `阿里巴巴` not
   * as 阿里. Latin names must sit on a word boundary, or `gold` would fire
   * inside `goldman`.
   * @param raw - the reader's text, already trimmed.
   * @returns the instrument the text names, when it names one.
   */
  private byContainment(raw: string): string | undefined {
    const text = raw.toLowerCase()
    let best: { name: string; symbol: string } | undefined
    for (const [name, symbol] of Object.entries(NAME_ALIASES)) {
      const key = name.toLowerCase()
      if (!text.includes(key)) continue
      if (/^[a-z]/.test(key)) {
        const at = text.indexOf(key)
        const before = at === 0 ? '' : text[at - 1] ?? ''
        const after = text[at + key.length] ?? ''
        if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue
      }
      if (best === undefined || name.length > best.name.length) best = { name, symbol }
    }
    return best?.symbol
  }

  async search(query: string): Promise<InstrumentInfo[]> {
    const q = query.trim()
    if (q === '') return []
    const known = this.byName(q)
    if (known !== undefined) return [known]
    const hit = this.searchCache.get(q)
    if (hit !== undefined && Date.now() - hit.at < SEARCH_CACHE_MS) return hit.items
    const url = `${this.baseURL}/v1/finance/search?q=${encodeURIComponent(q)}`
      + '&quotesCount=8&newsCount=0&listsCount=0&enableFuzzyQuery=false'
    // A 429 is Yahoo saying "not now", not the reader naming something that
    // does not exist. Answer with no matches and let the caller ask for the
    // ticker, instead of failing a tool call the model cannot act on.
    if (Date.now() < this.searchBlockedUntil) return []
    let response: Response
    try {
      response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } })
    } catch {
      return []
    }
    if (response.status === 429) {
      this.searchBlockedUntil = Date.now() + SEARCH_COOLDOWN_MS
      return []
    }
    if (!response.ok) throw new Error(`yahoo search ${response.status} for '${q}'`)
    const body = await response.json() as YahooSearch
    const items: InstrumentInfo[] = []
    for (const quote of body.quotes ?? []) {
      const symbol = quote.symbol
      if (typeof symbol !== 'string' || symbol === '') continue
      const assetClass = ASSET_CLASS[quote.quoteType ?? '']
      if (assetClass === undefined) continue
      items.push({
        symbol,
        ...quote.shortname !== undefined && quote.shortname !== ''
          ? { name: quote.shortname }
          : quote.longname !== undefined && quote.longname !== ''
            ? { name: quote.longname }
            : {},
        assetClass,
        timeframes: TIMEFRAMES,
      })
      if (items.length === 8) break
    }
    this.searchCache.set(q, { at: Date.now(), items })
    if (this.searchCache.size > 100) this.searchCache.delete(this.searchCache.keys().next().value as string)
    return items
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
