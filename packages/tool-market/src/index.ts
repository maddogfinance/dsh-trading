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
import { chartCandles, chartSeries, regimeSeries, roundSeries } from './chart-payload.js'
import type { AnnotationRole, ChartAnnotation, ChartPayload, ChartScenario, ChartTimeframeData } from './chart-payload.js'

export { rsi, sma } from './indicators.js'
export { adx, atr, bollinger, ema, macd, mfi, stochastic } from './candle-indicators.js'
export { regimeSnapshot, renderSnapshot } from './regime.js'
export type { RegimeSnapshot } from './regime.js'
export { chartHtml, renderChartSvg } from './chart.js'
export type { ChartLevel, ChartOptions, ChartOverlay } from './chart.js'
export { chartCandles, chartSeries, CHART_META_BARS } from './chart-payload.js'
export type {
  AnnotationRole, ChartAnnotation, ChartCandle, ChartLevelAnnotation, ChartPayload,
  ChartScenario, ChartSeries, ChartTimeframeData, ChartZoneAnnotation,
} from './chart-payload.js'

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

/**
 * Hard cap on bars served by one get_ohlcv call. The CSV block is rendered
 * into model context; an uncapped limit lets a single call crowd out the
 * analysis it was fetched for.
 */
const MAX_OHLCV_BARS = 2000

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
      limit: { type: 'integer', description: `Max bars, counted from the end of the range. Default 200, maximum ${MAX_OHLCV_BARS}.` },
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
          // Chart tail for the web card (@dsh-trading/client-chart), or null.
          // A json node compiles to an annotation-only schema, so this is not
          // a wire break; render() below never mentions it, so the model's
          // context does not grow by a byte.
          chart: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.symbol} @ ${value.timeframe} from '${value.provider}' — ${value.count} bars\n${value.csv}`,
      }],
      // Persisted on the durable tool/result event's `meta`: the card reads it
      // live and on session replay; the model never sees it.
      presentationMeta: (_args, value) => {
        const chart = value.chart as ChartTimeframeData | null
        if (chart === null) return null
        const payload: ChartPayload = {
          kind: 'chart',
          version: 1,
          provider: value.provider,
          symbol: value.symbol,
          timeframes: [chart],
        }
        return payload
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      if (args.limit !== undefined && args.limit > MAX_OHLCV_BARS) {
        throw new Error(`limit ${args.limit} exceeds the maximum ${MAX_OHLCV_BARS} bars per call — page through history with start/end ranges instead`)
      }
      const timeframe = args.timeframe as (typeof TIMEFRAMES)[number]
      const candles = await provider.getOhlcv({
        symbol: args.symbol,
        timeframe,
        ...args.start !== undefined ? { start: args.start } : {},
        ...args.end !== undefined ? { end: args.end } : {},
        limit: args.limit ?? 200,
      })
      const closes = candles.map(c => c.close)
      const indicators: Record<string, (number | null)[]> = {}
      for (const window of args.sma ?? []) indicators[`sma${window}`] = sma(closes, window)
      if (args.rsi !== undefined) indicators[`rsi${args.rsi}`] = rsi(closes, args.rsi)
      // Requested columns enter the payload at the same reporting precision
      // regimeSeries uses (CONTRACTS §2.1: rounded once, producer-side) — a
      // requested rsi14 must be byte-identical to the regime's rsi14, not a
      // full-precision shadow of it.
      const roundedIndicators = Object.fromEntries(Object.entries(indicators)
        .map(([name, values]) => [name, roundSeries(values, name.startsWith('rsi') ? 2 : 4)]))
      const tail = chartCandles(candles)
      const chart: ChartTimeframeData | null = tail === null || tail.length === 0 ? null : {
        timeframe,
        candles: tail,
        indicators: regimeSnapshot(candles),
        // Regime set first; requested columns win a name clash (identical after rounding).
        series: chartSeries({ ...regimeSeries(candles), ...roundedIndicators }),
      }
      return {
        provider: provider.id,
        symbol: args.symbol,
        timeframe: args.timeframe,
        count: candles.length,
        csv: renderCsv(candles, indicators),
        chart,
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
                // Chart tail + per-bar indicator series for the web card, or
                // null. Never rendered to the model; the durable copies travel
                // via presentationMeta below.
                candles: { type: 'json', required: true },
                series: { type: 'json', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.symbol} indicator regime from '${value.provider}':\n${value.timeframes.map(t => t.rendered).join('\n')}`,
      }],
      presentationMeta: (_args, value) => {
        const payload: ChartPayload = {
          kind: 'chart',
          version: 1,
          provider: value.provider,
          symbol: value.symbol,
          timeframes: value.timeframes
            .filter(t => t.candles !== null)
            .map(t => ({
              timeframe: t.timeframe,
              candles: t.candles,
              indicators: t.indicators,
              series: t.series,
            }) as ChartTimeframeData),
        }
        return payload
      },
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
          candles: chartCandles(candles),
          series: chartSeries(regimeSeries(candles)),
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

  const ANNOTATION_ROLES = ['support', 'resistance', 'neckline', 'target', 'invalidation', 'other'] as const

  // Structural caps: a card is a readable analysis surface, not a dump.
  const MAX_ANNOTATIONS = 24
  const MAX_SCENARIOS = 6
  const MAX_SOURCES = 6
  const MAX_PATH_POINTS = 12

  /** Strip control characters and cap length: model-authored text lands in a
   * durable log and is rendered by arbitrary ecosystem renderers. */
  const clean = (s: string, cap: number): string =>
    s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap)

  ctx.tools.register(defineTool({
    name: 'annotate_chart',
    description: 'Draw your analysis onto the interactive chart card: horizontal levels and zones, time-anchored paths (necklines, measured moves, pattern legs) — each with MANDATORY provenance sources — plus optional bull/bear scenarios with a trigger and an invalidation. Every price is hard-validated against the real candle window (\u00b130% of its low..high; roles target/invalidation get a wider \u00d70.5..\u00d72 band), so call market_snapshot or get_ohlcv FIRST and anchor on prices you actually read. Scenarios are research hypotheses labelled base/alternative \u2014 never trade recommendations, never numeric probabilities.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, enum: [...TIMEFRAMES], description: 'Timeframe the analysis was read on; prices are validated against THIS window.' },
      bars: { type: 'integer', description: 'Window drawn and validated against. Default 200.' },
      levels: {
        type: 'array',
        description: 'Horizontal price levels. Each must cite the evidence it rests on.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            price: { type: 'number', required: true },
            label: { type: 'string', required: true, description: 'Short caption, e.g. "double-bottom neckline".' },
            role: { type: 'string', enum: [...ANNOTATION_ROLES], description: 'Default "other".' },
            sources: { type: 'array', required: true, items: { type: 'string' }, description: 'Provenance, e.g. ["Fibonacci 0.618", "prior swing low"]. At least one.' },
            confidence: { type: 'number', description: '0..1. Omit rather than invent.' },
          },
        },
      },
      zones: {
        type: 'array',
        description: 'Horizontal price bands (supply/demand, confluence areas).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            low: { type: 'number', required: true },
            high: { type: 'number', required: true },
            label: { type: 'string', required: true },
            role: { type: 'string', enum: [...ANNOTATION_ROLES] },
            sources: { type: 'array', required: true, items: { type: 'string' } },
            confidence: { type: 'number' },
          },
        },
      },
      paths: {
        type: 'array',
        description: 'Time-anchored point sequences: pattern necklines, ABCD legs, measured moves. Times must be bar-open times inside the drawn window (small forward projection allowed).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            points: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  time: { type: 'string', required: true, description: 'ISO-8601 UTC bar-open time.' },
                  price: { type: 'number', required: true },
                },
              },
            },
            label: { type: 'string', required: true },
            role: { type: 'string', enum: [...ANNOTATION_ROLES] },
            sources: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
      },
      scenarios: {
        type: 'array',
        description: 'Conditional research scenarios: thesis + what confirms it + what kills it. stance labels the primary reading; it is not a probability.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            direction: { type: 'string', required: true, enum: ['bull', 'bear'] },
            stance: { type: 'string', required: true, enum: ['base', 'alternative'] },
            thesis: { type: 'string', required: true },
            trigger: { type: 'string', required: true, description: 'Observable that confirms the scenario.' },
            invalidation: { type: 'string', required: true, description: 'Observable that kills it.' },
            triggerPrice: { type: 'number', description: 'Optional price the trigger crosses; range-gated.' },
            invalidationPrice: { type: 'number', description: 'Optional price the invalidation crosses; range-gated.' },
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
          provider: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          chart: { type: 'json', required: true },
          scenarios: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
      presentationMeta: (_args, value) => {
        const chart = value.chart as ChartTimeframeData
        const scenarios = value.scenarios as ChartScenario[]
        const payload: ChartPayload = {
          kind: 'chart',
          version: 1,
          provider: value.provider,
          symbol: value.symbol,
          timeframes: [chart],
          ...scenarios.length > 0 ? { scenarios } : {},
        }
        return payload
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const timeframe = args.timeframe as Timeframe
      const candles = await provider.getOhlcv({ symbol: args.symbol, timeframe, limit: args.bars ?? 200 })
      if (candles.length === 0) throw new Error(`no candles for ${args.symbol} @ ${timeframe}`)
      const lo = Math.min(...candles.map(c => c.low))
      const hi = Math.max(...candles.map(c => c.high))
      const lastClose = candles[candles.length - 1]!.close
      const firstMs = Date.parse(candles[0]!.time)
      const lastMs = Date.parse(candles[candles.length - 1]!.time)
      const forwardMs = Math.max(0, (lastMs - firstMs) * 0.1)
      const range = `actual ${timeframe} window is low ${lo} \u2026 high ${hi} over the last ${candles.length} bars`
      const checkPrice = (price: number, what: string, role: AnnotationRole): void => {
        // Projection roles get a wider band: 1.618/2.618 extensions legitimately
        // clear a tight window's +30%.
        const wide = role === 'target' || role === 'invalidation'
        const floor = wide ? lo * 0.5 : lo * 0.7
        const ceil = wide ? hi * 2.0 : hi * 1.3
        if (!Number.isFinite(price) || price < floor || price > ceil) {
          throw new Error(`${what} ${price} is outside the plausible range for ${args.symbol} @ ${timeframe}: ${range} (tolerance \u00d7${wide ? '0.5..\u00d72.0' : '0.7..\u00d71.3'}). Anchor on prices you actually read \u2014 call market_snapshot or get_ohlcv first and cite real swing points.`)
        }
      }
      const checkConfidence = (confidence: number | undefined, what: string): void => {
        if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
          throw new Error(`${what} confidence must be within 0..1`)
        }
      }
      const checkSources = (sources: string[], what: string): string[] => {
        const cleaned = sources.map(s => clean(s, 120)).filter(s => s !== '').slice(0, MAX_SOURCES)
        if (cleaned.length === 0) {
          throw new Error(`${what} has no sources. Every annotation must cite its evidence (e.g. "prior swing high", "Fibonacci 0.618", "round number"). Unsourced annotations are refused.`)
        }
        return cleaned
      }
      const annotations: ChartAnnotation[] = []
      for (const level of args.levels ?? []) {
        const role = (level.role ?? 'other') as AnnotationRole
        const label = clean(level.label, 120)
        checkPrice(level.price, `level '${label}' at`, role)
        checkConfidence(level.confidence, `level '${label}'`)
        annotations.push({
          type: 'level', price: level.price, label, role,
          sources: checkSources(level.sources, `level '${label}'`),
          ...level.confidence !== undefined ? { confidence: level.confidence } : {},
        })
      }
      for (const zone of args.zones ?? []) {
        const role = (zone.role ?? 'other') as AnnotationRole
        const label = clean(zone.label, 120)
        if (!Number.isFinite(zone.low) || !Number.isFinite(zone.high) || zone.low >= zone.high) {
          throw new Error(`zone '${label}': low must be a finite number below high`)
        }
        if (zone.high - zone.low < lastClose * 0.0005) {
          throw new Error(`zone '${label}' is thinner than 0.05% of price \u2014 use a level for a single price`)
        }
        checkPrice(zone.low, `zone '${label}' low`, role)
        checkPrice(zone.high, `zone '${label}' high`, role)
        checkConfidence(zone.confidence, `zone '${label}'`)
        annotations.push({
          type: 'zone', low: zone.low, high: zone.high, label, role,
          sources: checkSources(zone.sources, `zone '${label}'`),
          ...zone.confidence !== undefined ? { confidence: zone.confidence } : {},
        })
      }
      for (const path of args.paths ?? []) {
        const role = (path.role ?? 'other') as AnnotationRole
        const label = clean(path.label, 120)
        const points = path.points ?? []
        if (points.length < 2 || points.length > MAX_PATH_POINTS) {
          throw new Error(`path '${label}' needs 2..${MAX_PATH_POINTS} points`)
        }
        const mapped = points.map((p) => {
          const t = Date.parse(p.time)
          if (!Number.isFinite(t) || t < firstMs || t > lastMs + forwardMs) {
            throw new Error(`path '${label}' point time ${p.time} is outside the drawn window ${candles[0]!.time} \u2026 ${candles[candles.length - 1]!.time} (small forward projection allowed). Use bar-open times you actually read.`)
          }
          checkPrice(p.price, `path '${label}' point at`, role)
          return { time: p.time, price: p.price }
        })
        annotations.push({
          type: 'path', points: mapped, label, role,
          sources: checkSources(path.sources, `path '${label}'`),
        })
      }
      if (annotations.length > MAX_ANNOTATIONS) {
        throw new Error(`too many annotations (${annotations.length} > ${MAX_ANNOTATIONS}): a readable analysis names its few decisive structures`)
      }
      const rawScenarios = args.scenarios ?? []
      if (rawScenarios.length > MAX_SCENARIOS) throw new Error(`too many scenarios (max ${MAX_SCENARIOS})`)
      const scenarios: ChartScenario[] = rawScenarios.map((s) => {
        if (s.triggerPrice !== undefined) checkPrice(s.triggerPrice, 'scenario triggerPrice', 'target')
        if (s.invalidationPrice !== undefined) checkPrice(s.invalidationPrice, 'scenario invalidationPrice', 'invalidation')
        return {
          direction: s.direction as 'bull' | 'bear',
          stance: s.stance as 'base' | 'alternative',
          thesis: clean(s.thesis, 300),
          trigger: clean(s.trigger, 300),
          invalidation: clean(s.invalidation, 300),
          ...s.triggerPrice !== undefined ? { triggerPrice: s.triggerPrice } : {},
          ...s.invalidationPrice !== undefined ? { invalidationPrice: s.invalidationPrice } : {},
        }
      })
      if (annotations.length === 0 && scenarios.length === 0) {
        throw new Error('nothing to annotate: pass at least one level, zone, path, or scenario')
      }
      const tail = chartCandles(candles)
      if (tail === null) throw new Error(`provider '${provider.id}' returned non-finite bars for ${args.symbol} @ ${timeframe}`)
      const chart: ChartTimeframeData = {
        timeframe,
        candles: tail,
        indicators: regimeSnapshot(candles),
        series: chartSeries(regimeSeries(candles)),
        annotations,
      }
      const counts = {
        level: annotations.filter(a => a.type === 'level').length,
        zone: annotations.filter(a => a.type === 'zone').length,
        path: annotations.filter(a => a.type === 'path').length,
      }
      return {
        provider: provider.id,
        symbol: args.symbol,
        timeframe: args.timeframe,
        summary: `Annotated ${args.symbol} @ ${args.timeframe}: ${counts.level} level(s), ${counts.zone} zone(s), ${counts.path} path(s), ${scenarios.length} scenario(s); all prices validated against the last ${candles.length} bars (${lo} \u2026 ${hi}). The chart card renders them.`,
        chart,
        scenarios,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Annotate: ${args.symbol} @ ${args.timeframe}`,
      kind: 'other',
      rawInput: args,
    }),
  }))
}
