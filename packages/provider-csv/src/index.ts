/**
 * Reference BYO provider: candles from local CSV files. Layout is one
 * directory per symbol, one file per timeframe:
 *
 *     <root>/AAPL/1d.csv
 *     <root>/BTC-USDT/1h.csv
 *
 * with the header `time,open,high,low,close,volume` and ISO-8601 UTC times,
 * ascending. Small by design — this package is the template a user copies to
 * put their OWN store (ClickHouse, broker API, CCXT) behind the same seam.
 * @module @dsh-trading/provider-csv
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Candle, InstrumentInfo, MarketDataProvider, OhlcvQuery, Timeframe } from '@dsh-trading/market-data'

export const name = 'provider-csv'
export const inject = ['marketData']

export interface Config {
  /** Directory holding `<symbol>/<timeframe>.csv` files. */
  root: string
  /** Registry id of this mount; several roots can coexist under distinct ids. */
  id?: string
}

export const Config: z<Config> = z.object({
  root: z.string().required(),
  id: z.string().default('csv'),
})

const TIMEFRAMES: ReadonlySet<string> = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'])
const HEADER = 'time,open,high,low,close,volume'

/**
 * Parse one CSV body into candles, failing loud on shape drift: a research
 * tool silently skipping malformed rows would bias every answer built on it.
 */
export function parseCsv(body: string, file: string): Candle[] {
  const lines = body.split(/\r?\n/).filter(line => line.trim().length > 0)
  if (lines[0]?.trim() !== HEADER) {
    throw new Error(`${file}: first line must be '${HEADER}' (got '${lines[0] ?? ''}')`)
  }
  return lines.slice(1).map((line, i) => {
    const cells = line.split(',')
    if (cells.length !== 6) {
      throw new Error(`${file}:${i + 2}: expected 6 columns, got ${cells.length}`)
    }
    const [time, ...nums] = cells
    const [open, high, low, close, volume] = nums.map(Number)
    if (Number.isNaN(Date.parse(time!))) {
      throw new Error(`${file}:${i + 2}: unparsable time '${time}'`)
    }
    if ([open, high, low, close, volume].some(v => !Number.isFinite(v))) {
      throw new Error(`${file}:${i + 2}: non-numeric OHLCV cell`)
    }
    if (high! < Math.max(open!, close!) || low! > Math.min(open!, close!)) {
      throw new Error(`${file}:${i + 2}: OHLC must satisfy low <= open/close <= high`)
    }
    if (volume! < 0) {
      throw new Error(`${file}:${i + 2}: volume must be non-negative`)
    }
    return { time: time!, open: open!, high: high!, low: low!, close: close!, volume: volume! }
  })
}

class CsvProvider implements MarketDataProvider {
  readonly description: string

  constructor(readonly id: string, private readonly root: string) {
    this.description = `Local CSV candles under ${root} (<symbol>/<timeframe>.csv)`
  }

  async listSymbols(): Promise<InstrumentInfo[]> {
    const entries = await readdir(this.root, { withFileTypes: true })
    const symbols: InstrumentInfo[] = []
    for (const entry of entries.filter(e => e.isDirectory())) {
      const files = await readdir(join(this.root, entry.name))
      const timeframes = files
        .filter(f => f.endsWith('.csv') && TIMEFRAMES.has(f.slice(0, -4)))
        .map(f => f.slice(0, -4) as Timeframe)
      if (timeframes.length > 0) symbols.push({ symbol: entry.name, timeframes })
    }
    return symbols
  }

  async getOhlcv(query: OhlcvQuery): Promise<Candle[]> {
    const file = join(this.root, query.symbol, `${query.timeframe}.csv`)
    let body: string
    try {
      body = await readFile(file, 'utf8')
    } catch {
      throw new Error(`no data for ${query.symbol} @ ${query.timeframe} (expected ${file})`)
    }
    let candles = parseCsv(body, file)
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
}

export function apply(ctx: Context, config: Config): void {
  // ctx.effect ties the registration to this plugin's fiber: unloading the
  // provider row runs the disposer and unmounts it from the hub.
  ctx.effect(() => ctx.marketData.register(new CsvProvider(config.id ?? 'csv', config.root)))
}
