/**
 * Model-facing market tools. Read-only by contract: this package (and the
 * dsh-trading project) exposes RESEARCH capabilities — nothing here places,
 * routes, or simulates-then-forwards orders, and no order-execution seam
 * exists for a plugin to reach. Analysis stops at the screen.
 * @module @dsh-trading/tool-market
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Candle, Timeframe } from '@dsh-trading/market-data'
import { ema, macd } from './candle-indicators.js'
import { rsi, sma } from './indicators.js'
import { regimeSnapshot, renderSnapshot } from './regime.js'
import { chartHtml, renderChartSvg } from './chart.js'
import type { ChartLevel, ChartOverlay } from './chart.js'

export { rsi, sma } from './indicators.js'
export { adx, atr, bollinger, ema, macd, mfi, stochastic } from './candle-indicators.js'
export { regimeSnapshot, renderSnapshot } from './regime.js'
export type { RegimeSnapshot } from './regime.js'
export { chartHtml, renderChartSvg } from './chart.js'
export type { ChartLevel, ChartOptions, ChartOverlay } from './chart.js'

export const name = 'tool-market'
export const inject = ['tools', 'marketData']

export interface Config {
  /** Directory charts are written to, relative to the process working directory. */
  chartDir: string
}

export const Config: z<Config> = z.object({
  chartDir: z.string().default('./charts'),
})

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const

/** Render candles (+ indicator columns) as the CSV block the model reads. */
function renderCsv(candles: Candle[], indicators: Record<string, (number | null)[]>): string {
  const extraNames = Object.keys(indicators)
  const header = ['time,open,high,low,close,volume', ...extraNames].join(',')
  const rows = candles.map((c, i) => [
    `${c.time},${c.open},${c.high},${c.low},${c.close},${c.volume}`,
    ...extraNames.map(name => indicators[name]![i]?.toFixed(4) ?? ''),
  ].join(','))
  return [header, ...rows].join('\n')
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'list_symbols',
    description: 'List the instruments available from the mounted market-data providers, with the timeframes each one can serve. Call this before get_ohlcv when unsure which symbols exist.',
    parameters: {
      provider: { type: 'string', description: 'Provider id to enumerate. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          symbols: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                symbol: { type: 'string', required: true },
                timeframes: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.symbols.length === 0
          ? `Provider '${value.provider}' has no instruments.`
          : value.symbols.map(s => `${s.symbol}${s.timeframes ? ` (${s.timeframes.join(', ')})` : ''}`).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const symbols = await provider.listSymbols()
      return {
        provider: provider.id,
        symbols: symbols.map(s => ({
          symbol: s.symbol,
          ...s.timeframes ? { timeframes: [...s.timeframes] } : {},
        })),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'List symbols', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'get_ohlcv',
    description: 'Fetch OHLCV candles for one symbol and timeframe as CSV, optionally with SMA/RSI indicator columns. Times are ISO-8601 UTC bar-open times, ascending. Use list_symbols first if the symbol universe is unknown.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, enum: [...TIMEFRAMES], description: 'Bar interval.' },
      start: { type: 'string', description: 'Inclusive ISO-8601 range start (bar open time).' },
      end: { type: 'string', description: 'Inclusive ISO-8601 range end.' },
      limit: { type: 'integer', description: 'Max bars, counted from the end of the range. Default 200.' },
      sma: { type: 'array', items: { type: 'integer' }, description: 'SMA windows to append as columns, e.g. [20, 50].' },
      rsi: { type: 'integer', description: 'RSI period to append as a column, e.g. 14.' },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          csv: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.symbol} @ ${value.timeframe} from '${value.provider}' — ${value.count} bars\n${value.csv}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const candles = await provider.getOhlcv({
        symbol: args.symbol,
        timeframe: args.timeframe as (typeof TIMEFRAMES)[number],
        ...args.start !== undefined ? { start: args.start } : {},
        ...args.end !== undefined ? { end: args.end } : {},
        limit: args.limit ?? 200,
      })
      const closes = candles.map(c => c.close)
      const indicators: Record<string, (number | null)[]> = {}
      for (const window of args.sma ?? []) indicators[`sma${window}`] = sma(closes, window)
      if (args.rsi !== undefined) indicators[`rsi${args.rsi}`] = rsi(closes, args.rsi)
      return {
        provider: provider.id,
        symbol: args.symbol,
        timeframe: args.timeframe,
        count: candles.length,
        csv: renderCsv(candles, indicators),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Candles: ${args.symbol} @ ${args.timeframe}`,
      kind: 'read',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'market_snapshot',
    description: 'Multi-timeframe indicator dashboard for one symbol: latest close, RSI14, slow stochastic, ADX/DI, MACD(12,26,9), MFI14, ATR14, SMA20/50/200 + EMA20 posture, Bollinger(20,2) — each with a coarse state label. Call this FIRST when asked to analyse an instrument; fetch raw candles with get_ohlcv only when you need bar-level structure.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframes: {
        type: 'array',
        items: { type: 'string', enum: [...TIMEFRAMES] },
        description: 'Timeframes to compute, e.g. ["1d", "4h"]. Default ["1d"].',
      },
      bars: { type: 'integer', description: 'Bars fetched per timeframe (more = better-seeded slow indicators). Default 300.' },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          timeframes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                timeframe: { type: 'string', required: true },
                rendered: { type: 'string', required: true },
                // The full RegimeSnapshot, as an unconstrained JSON node: UI
                // cards will read it, and adding an indicator must not be a
                // wire-schema break.
                indicators: { type: 'json', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.symbol} indicator regime from '${value.provider}':\n${value.timeframes.map(t => t.rendered).join('\n')}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const timeframes = (args.timeframes ?? ['1d']) as Timeframe[]
      const results = await Promise.all(timeframes.map(async (timeframe) => {
        const candles = await provider.getOhlcv({ symbol: args.symbol, timeframe, limit: args.bars ?? 300 })
        if (candles.length === 0) throw new Error(`no candles for ${args.symbol} @ ${timeframe}`)
        const snapshot = regimeSnapshot(candles)
        return {
          timeframe,
          rendered: renderSnapshot(timeframe, snapshot),
          indicators: snapshot,
        }
      }))
      return { provider: provider.id, symbol: args.symbol, timeframes: results }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Indicator regime: ${args.symbol}`,
      kind: 'read',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'render_chart',
    description: 'Draw a candlestick chart to a self-contained HTML file and return its path: candles with volume, optional SMA/EMA overlays, and dashed horizontal lines for the levels you name. Use it to show the structure an analysis argues for — call it AFTER market_snapshot so the levels you mark are ones you actually read.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, enum: [...TIMEFRAMES], description: 'Bar interval to draw.' },
      bars: { type: 'integer', description: 'How many recent bars to draw. Default 120; more than ~400 renders too densely to read.' },
      sma: { type: 'array', items: { type: 'integer' }, description: 'SMA windows to overlay, e.g. [20, 50].' },
      ema: { type: 'array', items: { type: 'integer' }, description: 'EMA windows to overlay, e.g. [20].' },
      macd: { type: 'boolean', description: 'Overlay the MACD line instead of leaving the pane to price alone. Rarely useful on a price axis; default false.' },
      levels: {
        type: 'array',
        description: 'Horizontal lines to mark, e.g. support, resistance, band edges.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            price: { type: 'number', required: true },
            label: { type: 'string', required: true, description: 'Short caption drawn above the line.' },
          },
        },
      },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          bars: { type: 'integer', required: true },
          firstTime: { type: 'string', required: true },
          lastTime: { type: 'string', required: true },
        },
      },
      // The SVG itself never reaches the model: it is tens of kilobytes of path
      // data that would crowd out the analysis it exists to illustrate.
      render: (_args, value) => [{
        type: 'text',
        text: `Chart written to ${value.path} — ${value.symbol} @ ${value.timeframe}, ${value.bars} bars (${value.firstTime} … ${value.lastTime}). Open it in a browser to view.`,
      }],
    },
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const candles = await provider.getOhlcv({
        symbol: args.symbol,
        timeframe: args.timeframe as Timeframe,
        limit: args.bars ?? 120,
      })
      if (candles.length === 0) throw new Error(`no candles for ${args.symbol} @ ${args.timeframe}`)
      const closes = candles.map(c => c.close)
      const overlays: ChartOverlay[] = [
        ...(args.sma ?? []).map(w => ({ name: `SMA${w}`, values: sma(closes, w) })),
        ...(args.ema ?? []).map(w => ({ name: `EMA${w}`, values: ema(closes, w) })),
        ...args.macd === true ? [{ name: 'MACD', values: macd(closes).macd }] : [],
      ]
      const levels: ChartLevel[] = (args.levels ?? []).map(l => ({ price: l.price, label: l.label }))
      const title = `${args.symbol} · ${args.timeframe} · ${candles.length} bars`
      const svg = renderChartSvg({ title, candles, overlays, levels })

      // Names are per symbol+timeframe, not per call: a re-drawn chart should
      // replace the one it supersedes rather than litter the directory.
      const dir = isAbsolute(config.chartDir) ? config.chartDir : resolve(process.cwd(), config.chartDir)
      const path = join(dir, `${args.symbol.replace(/[^\w.-]/g, '_')}-${args.timeframe}.html`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, chartHtml(title, svg))
      return {
        path,
        symbol: args.symbol,
        timeframe: args.timeframe,
        bars: candles.length,
        firstTime: candles[0]!.time,
        lastTime: candles[candles.length - 1]!.time,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Chart: ${args.symbol} @ ${args.timeframe}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}
