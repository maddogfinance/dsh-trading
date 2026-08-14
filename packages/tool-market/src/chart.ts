/**
 * Standalone SVG candlestick rendering. No chart library and no external
 * fetches: the output is one self-contained string that renders in any browser
 * or viewer, which is what lets a tool result carry a picture before the web
 * UI has a chart card of its own.
 *
 * Pure and deterministic like the indicator math — the same candles always
 * produce byte-identical SVG, so a replayed session shows the same chart.
 * @module @dsh-trading/tool-market
 */

import type { Candle } from '@dsh-trading/market-data'

/** A horizontal line drawn across the price pane, e.g. a moving average level. */
export interface ChartLevel {
  price: number
  label: string
  /** Any CSS color. Defaults to the muted level color. */
  color?: string
}

/** An overlay series aligned index-for-index with the candles (nulls skipped). */
export interface ChartOverlay {
  name: string
  values: readonly (number | null)[]
  color?: string
}

export interface ChartOptions {
  title: string
  candles: readonly Candle[]
  levels?: readonly ChartLevel[]
  overlays?: readonly ChartOverlay[]
  width?: number
  height?: number
}

const THEME = {
  bg: '#0d1117',
  grid: '#1f2630',
  text: '#8b949e',
  title: '#e6edf3',
  up: '#26a69a',
  down: '#ef5350',
  level: '#6e7681',
  volume: '#30363d',
}

const OVERLAY_COLORS = ['#58a6ff', '#d29922', '#bc8cff', '#3fb950']

/** Escape text for inclusion in SVG character data. */
function esc(text: string): string {
  return text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

/** Round to 2 decimals for compact, stable path data. */
const n = (v: number): string => (Math.round(v * 100) / 100).toString()

/**
 * Render candles as a self-contained SVG string.
 * @param options - the series, its overlays and levels, and the canvas size.
 * @returns one `<svg>` document.
 */
export function renderChartSvg(options: ChartOptions): string {
  const { title, candles, levels = [], overlays = [] } = options
  if (candles.length === 0) throw new Error('renderChartSvg requires at least one candle')
  const width = options.width ?? 1000
  const height = options.height ?? 560
  const pad = { top: 44, right: 78, bottom: 28, left: 12 }
  const volumeH = 64
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom - volumeH - 10

  // Price scale spans the candles AND every level, so a level never falls off.
  const lows = candles.map(c => c.low)
  const highs = candles.map(c => c.high)
  const levelPrices = levels.map(l => l.price)
  let min = Math.min(...lows, ...levelPrices)
  let max = Math.max(...highs, ...levelPrices)
  const span = max - min || Math.abs(max) || 1
  min -= span * 0.04
  max += span * 0.04
  const y = (price: number): number => pad.top + plotH - ((price - min) / (max - min)) * plotH

  const step = plotW / candles.length
  const bodyW = Math.max(1, Math.min(12, step * 0.65))
  const x = (i: number): number => pad.left + i * step + step / 2

  const maxVolume = Math.max(...candles.map(c => c.volume), 1)
  const volumeTop = pad.top + plotH + 10
  const parts: string[] = []

  parts.push(`<rect width="${width}" height="${height}" fill="${THEME.bg}"/>`)
  parts.push(`<text x="${pad.left}" y="26" fill="${THEME.title}" font-size="15" font-family="ui-sans-serif,system-ui,sans-serif" font-weight="600">${esc(title)}</text>`)

  // Price gridlines and right-hand axis labels.
  for (let g = 0; g <= 4; g++) {
    const price = min + ((max - min) * g) / 4
    const gy = y(price)
    parts.push(`<line x1="${pad.left}" y1="${n(gy)}" x2="${pad.left + plotW}" y2="${n(gy)}" stroke="${THEME.grid}" stroke-width="1"/>`)
    parts.push(`<text x="${pad.left + plotW + 6}" y="${n(gy + 4)}" fill="${THEME.text}" font-size="11" font-family="ui-monospace,monospace">${n(price)}</text>`)
  }

  // Volume pane, drawn under the price pane and behind everything else.
  for (const [i, c] of candles.entries()) {
    const h = (c.volume / maxVolume) * volumeH
    parts.push(`<rect x="${n(x(i) - bodyW / 2)}" y="${n(volumeTop + volumeH - h)}" width="${n(bodyW)}" height="${n(h)}" fill="${THEME.volume}"/>`)
  }

  // Candles: one wick line plus one body rect, colored by direction.
  for (const [i, c] of candles.entries()) {
    const color = c.close >= c.open ? THEME.up : THEME.down
    const cx = x(i)
    parts.push(`<line x1="${n(cx)}" y1="${n(y(c.high))}" x2="${n(cx)}" y2="${n(y(c.low))}" stroke="${color}" stroke-width="1"/>`)
    const top = y(Math.max(c.open, c.close))
    // A doji would render as a zero-height rect; floor it so the bar stays visible.
    const bodyH = Math.max(1, Math.abs(y(c.open) - y(c.close)))
    parts.push(`<rect x="${n(cx - bodyW / 2)}" y="${n(top)}" width="${n(bodyW)}" height="${n(bodyH)}" fill="${color}"/>`)
  }

  // Overlay series, skipping unseeded leading positions.
  for (const [oi, overlay] of overlays.entries()) {
    const color = overlay.color ?? OVERLAY_COLORS[oi % OVERLAY_COLORS.length]!
    let d = ''
    let pen = false
    for (const [i, value] of overlay.values.entries()) {
      if (value === null || value === undefined || i >= candles.length) { pen = false; continue }
      d += `${pen ? 'L' : 'M'}${n(x(i))} ${n(y(value))}`
      pen = true
    }
    if (d !== '') {
      parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="1.4" opacity="0.9"/>`)
    }
    parts.push(`<text x="${pad.left + 6 + oi * 86}" y="41" fill="${color}" font-size="11" font-family="ui-monospace,monospace">${esc(overlay.name)}</text>`)
  }

  // Levels last, so a key price is never hidden behind a candle body.
  for (const level of levels) {
    const ly = y(level.price)
    const color = level.color ?? THEME.level
    parts.push(`<line x1="${pad.left}" y1="${n(ly)}" x2="${pad.left + plotW}" y2="${n(ly)}" stroke="${color}" stroke-width="1" stroke-dasharray="4 3" opacity="0.85"/>`)
    parts.push(`<text x="${pad.left + 4}" y="${n(ly - 4)}" fill="${color}" font-size="10.5" font-family="ui-monospace,monospace">${esc(level.label)}</text>`)
  }

  // Time axis: first, middle and last bar only — a dense axis is unreadable
  // at this width and the model already has exact times in the CSV.
  const ticks = [0, Math.floor((candles.length - 1) / 2), candles.length - 1]
  const anchors = ['start', 'middle', 'end']
  for (const [ti, i] of ticks.entries()) {
    const label = candles[i]!.time.replace('T', ' ').replace('Z', '')
    parts.push(`<text x="${n(x(i))}" y="${height - 8}" fill="${THEME.text}" font-size="10.5" text-anchor="${anchors[ti]}" font-family="ui-monospace,monospace">${esc(label)}</text>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">${parts.join('')}</svg>`
}

/** Wrap one SVG in a minimal self-contained HTML document. */
export function chartHtml(title: string, svg: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>html,body{margin:0;background:${THEME.bg};color:${THEME.title};font-family:ui-sans-serif,system-ui,sans-serif}
body{display:flex;align-items:center;justify-content:center;min-height:100vh}svg{max-width:100%;height:auto}</style>
</head><body>${svg}</body></html>
`
}
