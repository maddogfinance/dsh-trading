/**
 * The candlestick card claiming the `tool.call.toolview` slot for
 * `market_snapshot`, `get_ohlcv`, and `annotate_chart`. Reads the durable,
 * model-invisible chart payload from `block.meta`; degrades to the raw
 * rendered text when the payload is absent.
 *
 * Extensibility: annotation rendering is an open registry. A renderer is a
 * PURE function from an annotation object to declarative draw primitives
 * (hline / region / polyline) — it never touches the charting library, so
 * third-party renderers survive chart re-inits (tab switch, chip toggle,
 * theme change) and klinecharts upgrades. Core types 'level', 'zone', 'path'
 * go through the same registry; unknown types without a renderer fall back
 * to a textual row in the annotations table.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { dispose, init, registerIndicator, registerOverlay } from 'klinecharts'
import type { Chart, OverlayCreateFiguresCallbackParams } from 'klinecharts'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { contentText, readChartPayload } from './payload.js'
import type { ChartAnnotation, ChartScenario, ChartTimeframeData } from './payload.js'

const CHART_HEIGHT = 320
const PANE_HEIGHT = 90

type Palette = {
  text: string
  faint: string
  line: string
  up: string
  down: string
  neckline: string
  target: string
  invalidation: string
}

const LIGHT: Palette = {
  text: '#333c45', faint: '#8b949e', line: '#e5e8eb', up: '#26a17b', down: '#e0563f',
  neckline: '#b08800', target: '#3b7dd8', invalidation: '#a475e0',
}
const DARK: Palette = {
  text: '#c9d1d9', faint: '#768390', line: '#30363d', up: '#3ddc97', down: '#f47067',
  neckline: '#d4a72c', target: '#539bf5', invalidation: '#b083f0',
}

/* ------------------------------------------------------------------ */
/* Open annotation-renderer registry (the ecosystem seam)              */
/* ------------------------------------------------------------------ */

export type DrawPrimitive =
  | { kind: 'hline'; price: number; label?: string; color?: string; dashed?: boolean }
  | { kind: 'region'; low: number; high: number; label?: string; color?: string }
  | { kind: 'polyline'; points: { time: string; price: number }[]; label?: string; color?: string; dashed?: boolean }

export type AnnotationRendererContext = {
  /** Bumped only on breaking changes to DrawPrimitive/this context. */
  contractVersion: 1
  timeframe: string
  close: number
  palette: Palette
}

/**
 * PURE translator from one annotation object to draw primitives. Runs on
 * every chart re-init; must not keep state or touch the DOM. Throwing skips
 * this annotation (logged), never the card.
 */
export type AnnotationRenderer = (
  annotation: Record<string, unknown>,
  ctx: AnnotationRendererContext,
) => DrawPrimitive[]

const annotationRenderers = new Map<string, AnnotationRenderer>()

/** Last registration wins (logged); returns an unregister disposer. */
export function registerAnnotationRenderer(type: string, renderer: AnnotationRenderer): () => void {
  if (annotationRenderers.has(type)) {
    console.warn(`[client-chart] annotation renderer for '${type}' replaced`)
  }
  annotationRenderers.set(type, renderer)
  return () => {
    if (annotationRenderers.get(type) === renderer) annotationRenderers.delete(type)
  }
}

function roleColor(role: unknown, p: Palette): string {
  switch (role) {
    case 'support': return p.up
    case 'resistance': return p.down
    case 'neckline': return p.neckline
    case 'target': return p.target
    case 'invalidation': return p.invalidation
    default: return p.faint
  }
}

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

// Core renderers ride the same registry as third-party ones.
registerAnnotationRenderer('level', (a, ctx) => {
  const price = num(a['price'])
  if (price === undefined) return []
  return [{ kind: 'hline', price, dashed: true, color: roleColor(a['role'], ctx.palette), ...str(a['label']) !== undefined ? { label: str(a['label'])! } : {} }]
})
registerAnnotationRenderer('zone', (a, ctx) => {
  const low = num(a['low'])
  const high = num(a['high'])
  if (low === undefined || high === undefined) return []
  return [{ kind: 'region', low, high, color: roleColor(a['role'], ctx.palette), ...str(a['label']) !== undefined ? { label: str(a['label'])! } : {} }]
})
registerAnnotationRenderer('path', (a, ctx) => {
  const raw = a['points']
  if (!Array.isArray(raw)) return []
  const points = raw.flatMap((p) => {
    const time = typeof p === 'object' && p !== null ? str((p as Record<string, unknown>)['time']) : undefined
    const price = typeof p === 'object' && p !== null ? num((p as Record<string, unknown>)['price']) : undefined
    return time !== undefined && price !== undefined ? [{ time, price }] : []
  })
  if (points.length < 2) return []
  return [{ kind: 'polyline', points, dashed: true, color: roleColor(a['role'], ctx.palette), ...str(a['label']) !== undefined ? { label: str(a['label'])! } : {} }]
})

/* ------------------------------------------------------------------ */
/* klinecharts wiring                                                  */
/* ------------------------------------------------------------------ */

let registered = false

function ensureRegistered(): void {
  if (registered) return
  registered = true
  // Data rides extendData, not calcParams: klinecharts prints calcParams into
  // the pane's tooltip title, which would render as "[object Object]" spam.
  const passthrough = (_dl: unknown[], ind: { extendData: unknown }): unknown[] =>
    ind.extendData as unknown[]
  const line = (key: string, title: string): { key: string; title: string; type: string } =>
    ({ key, title: `${title}: `, type: 'line' })
  const defs: { name: string; shortName: string; figures: { key: string; title: string; type: string; baseValue?: number }[] }[] = [
    { name: 'TM_RSI', shortName: 'RSI14*', figures: [line('rsi', 'RSI14')] },
    { name: 'TM_STOCH', shortName: 'STOCH*', figures: [line('k', 'K'), line('d', 'D')] },
    { name: 'TM_ADX', shortName: 'ADX*', figures: [line('adx', 'ADX'), line('pdi', '+DI'), line('mdi', '-DI')] },
    { name: 'TM_MACD', shortName: 'MACD*', figures: [{ key: 'hist', title: 'HIST: ', type: 'bar', baseValue: 0 }, line('macd', 'MACD'), line('signal', 'SIGNAL')] },
    { name: 'TM_MFI', shortName: 'MFI14*', figures: [line('mfi', 'MFI14')] },
    { name: 'TM_BB', shortName: 'BB(20,2)*', figures: [line('upper', 'UP'), line('middle', 'MID'), line('lower', 'LOW')] },
  ]
  for (const def of defs) {
    registerIndicator({ ...def, calc: passthrough } as never)
  }

  // Overlay shapes for the draw primitives. extendData: { color, dashed, label }.
  registerOverlay({
    name: 'tm_hline',
    totalStep: 2,
    lock: true,
    createPointFigures: ({ coordinates, bounding, overlay }: OverlayCreateFiguresCallbackParams) => {
      const y = coordinates[0]?.y
      if (y === undefined) return []
      const ext = (overlay.extendData ?? {}) as Record<string, unknown>
      const color = typeof ext['color'] === 'string' ? ext['color'] : '#888888'
      const figures: unknown[] = [{
        type: 'line',
        attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
        styles: { style: typeof ext['dashed'] === 'boolean' && ext['dashed'] ? 'dashed' : 'solid', color },
        ignoreEvent: true,
      }]
      if (typeof ext['label'] === 'string' && ext['label'] !== '') {
        figures.push({
          type: 'text',
          attrs: { x: 6, y: y - 4, text: ext['label'], baseline: 'bottom' },
          styles: { color, size: 10, backgroundColor: 'transparent' },
          ignoreEvent: true,
        })
      }
      return figures as never
    },
  } as never)
  registerOverlay({
    name: 'tm_region',
    totalStep: 3,
    lock: true,
    createPointFigures: ({ coordinates, bounding, overlay }: OverlayCreateFiguresCallbackParams) => {
      const y0 = coordinates[0]?.y
      const y1 = coordinates[1]?.y
      if (y0 === undefined || y1 === undefined) return []
      const ext = (overlay.extendData ?? {}) as Record<string, unknown>
      const color = typeof ext['color'] === 'string' ? ext['color'] : '#888888'
      const top = Math.min(y0, y1)
      const figures: unknown[] = [{
        type: 'rect',
        attrs: { x: 0, y: top, width: bounding.width, height: Math.abs(y1 - y0) },
        styles: { style: 'fill', color: `${color}26` },
        ignoreEvent: true,
      }]
      if (typeof ext['label'] === 'string' && ext['label'] !== '') {
        figures.push({
          type: 'text',
          attrs: { x: 6, y: top - 4, text: ext['label'], baseline: 'bottom' },
          styles: { color, size: 10, backgroundColor: 'transparent' },
          ignoreEvent: true,
        })
      }
      return figures as never
    },
  } as never)
  registerOverlay({
    name: 'tm_polyline',
    totalStep: 14,
    lock: true,
    createPointFigures: ({ coordinates, overlay }: OverlayCreateFiguresCallbackParams) => {
      if (coordinates.length < 2) return []
      const ext = (overlay.extendData ?? {}) as Record<string, unknown>
      const color = typeof ext['color'] === 'string' ? ext['color'] : '#888888'
      const last = coordinates[coordinates.length - 1]!
      const figures: unknown[] = [{
        type: 'line',
        attrs: { coordinates: [...coordinates] },
        styles: { style: typeof ext['dashed'] === 'boolean' && ext['dashed'] ? 'dashed' : 'solid', color },
        ignoreEvent: true,
      }]
      if (typeof ext['label'] === 'string' && ext['label'] !== '') {
        figures.push({
          type: 'text',
          attrs: { x: last.x + 4, y: last.y, text: ext['label'], baseline: 'middle' },
          styles: { color, size: 10, backgroundColor: 'transparent' },
          ignoreEvent: true,
        })
      }
      return figures as never
    },
  } as never)
}

function useDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent): void => setDark(e.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return dark
}

function klineStyles(p: Palette): Record<string, unknown> {
  const tick = { color: p.faint }
  return {
    grid: { horizontal: { color: p.line }, vertical: { color: p.line } },
    candle: {
      bar: {
        upColor: p.up, downColor: p.down, noChangeColor: p.faint,
        upBorderColor: p.up, downBorderColor: p.down, noChangeBorderColor: p.faint,
        upWickColor: p.up, downWickColor: p.down, noChangeWickColor: p.faint,
      },
      priceMark: {
        high: { color: p.faint },
        low: { color: p.faint },
        last: { upColor: p.up, downColor: p.down, noChangeColor: p.faint },
      },
      tooltip: { text: { color: p.text } },
    },
    indicator: { tooltip: { text: { color: p.text } } },
    xAxis: { axisLine: { color: p.line }, tickText: tick, tickLine: { color: p.line } },
    yAxis: { axisLine: { color: p.line }, tickText: tick, tickLine: { color: p.line } },
    separator: { color: p.line },
    crosshair: {
      horizontal: { line: { color: p.faint }, text: { backgroundColor: p.faint } },
      vertical: { line: { color: p.faint }, text: { backgroundColor: p.faint } },
    },
  }
}

/** Map payload series onto klinecharts rows for one chip's figures. */
function seriesRows(data: ChartTimeframeData, figures: Record<string, string>): Record<string, number | undefined>[] {
  return data.candles.map((_, i) => {
    const row: Record<string, number | undefined> = {}
    for (const [figKey, seriesKey] of Object.entries(figures)) {
      const v = data.series?.[seriesKey]?.[i]
      row[figKey] = typeof v === 'number' ? v : undefined
    }
    return row
  })
}

function hasSeries(data: ChartTimeframeData, figures: Record<string, string>): boolean {
  const series = data.series
  if (series === undefined) return false
  return Object.values(figures).every((key) => {
    const col = series[key]
    return Array.isArray(col) && col.length === data.candles.length
  })
}

type ChipDef = {
  id: string
  indicator?: { name: string; figures: Record<string, string>; overlay?: boolean }
  label: (ind: Record<string, unknown>) => { text: string; state: unknown }
}

const CHIP_DEFS: ChipDef[] = [
  { id: 'rsi', indicator: { name: 'TM_RSI', figures: { rsi: 'rsi14' } }, label: ind => ({ text: `RSI14 ${fmt(get(ind['rsi14'], 'value'))}`, state: get(ind['rsi14'], 'state') }) },
  { id: 'stoch', indicator: { name: 'TM_STOCH', figures: { k: 'stoch_k', d: 'stoch_d' } }, label: ind => ({ text: `Stoch ${fmt(get(ind['stochastic'], 'k'))}/${fmt(get(ind['stochastic'], 'd'))}`, state: get(ind['stochastic'], 'state') }) },
  { id: 'adx', indicator: { name: 'TM_ADX', figures: { adx: 'adx', pdi: 'plus_di', mdi: 'minus_di' } }, label: ind => ({ text: `ADX ${fmt(get(ind['adx14'], 'value'))}`, state: get(ind['adx14'], 'state') }) },
  { id: 'macd', indicator: { name: 'TM_MACD', figures: { hist: 'macd_hist', macd: 'macd', signal: 'macd_signal' } }, label: ind => ({ text: `MACD ${fmt(get(ind['macd'], 'histogram'))}`, state: get(ind['macd'], 'state') }) },
  { id: 'mfi', indicator: { name: 'TM_MFI', figures: { mfi: 'mfi14' } }, label: ind => ({ text: `MFI ${fmt(get(ind['mfi14'], 'value'))}`, state: get(ind['mfi14'], 'state') }) },
  { id: 'bb', indicator: { name: 'TM_BB', figures: { upper: 'bb_upper', middle: 'bb_middle', lower: 'bb_lower' }, overlay: true }, label: ind => ({ text: 'BB(20,2)', state: get(ind['bollinger20'], 'state') }) },
  { id: 'ma', label: ind => ({ text: 'MA posture', state: get(ind['movingAverages'], 'closeVs') }) },
]

function drawPrimitive(chart: Pick<Chart, 'createOverlay'>, prim: DrawPrimitive): void {
  if (prim.kind === 'hline') {
    chart.createOverlay({
      name: 'tm_hline', lock: true,
      points: [{ value: prim.price }],
      extendData: { color: prim.color, dashed: prim.dashed ?? false, label: prim.label ?? '' },
    })
  } else if (prim.kind === 'region') {
    chart.createOverlay({
      name: 'tm_region', lock: true,
      points: [{ value: prim.low }, { value: prim.high }],
      extendData: { color: prim.color, label: prim.label ?? '' },
    })
  } else {
    chart.createOverlay({
      name: 'tm_polyline', lock: true,
      points: prim.points.map(p => ({ timestamp: Date.parse(p.time), value: p.price })),
      extendData: { color: prim.color, dashed: prim.dashed ?? false, label: prim.label ?? '' },
    })
  }
}

function Kline({ data, scenarios, dark, active }: {
  data: ChartTimeframeData
  scenarios: ChartScenario[]
  dark: boolean
  active: string[]
}): JSX.Element {
  const el = useRef<HTMLDivElement>(null)
  const paneCount = active.filter(id => CHIP_DEFS.find(d => d.id === id)?.indicator?.overlay !== true).length
  useEffect(() => {
    const container = el.current
    if (container === null) return
    ensureRegistered()
    const palette = dark ? DARK : LIGHT
    const chart = init(container)
    if (chart === null) return
    chart.setStyles(klineStyles(palette))
    chart.applyNewData(data.candles.map(c => ({
      timestamp: Date.parse(c.time),
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    })))
    chart.createIndicator({ name: 'MA', calcParams: [20, 50, 200] }, true, { id: 'candle_pane' })
    chart.createIndicator('VOL')
    for (const id of active) {
      const def = CHIP_DEFS.find(d => d.id === id)
      if (def?.indicator === undefined || !hasSeries(data, def.indicator.figures)) continue
      const create = { name: def.indicator.name, extendData: seriesRows(data, def.indicator.figures) }
      if (def.indicator.overlay === true) chart.createIndicator(create, true, { id: 'candle_pane' })
      else chart.createIndicator(create, false, { height: PANE_HEIGHT })
    }
    const close = data.candles[data.candles.length - 1]!.close
    const ctx: AnnotationRendererContext = { contractVersion: 1, timeframe: data.timeframe, close, palette }
    for (const annotation of data.annotations ?? []) {
      const renderer = annotationRenderers.get(annotation.type)
      if (renderer === undefined) continue
      try {
        for (const prim of renderer(annotation, ctx)) drawPrimitive(chart, prim)
      } catch (error) {
        console.warn(`[client-chart] renderer for '${annotation.type}' failed`, error)
      }
    }
    for (const s of scenarios) {
      if (s.triggerPrice !== undefined) drawPrimitive(chart, { kind: 'hline', price: s.triggerPrice, dashed: true, color: palette.target, label: `trigger (${s.direction})` })
      if (s.invalidationPrice !== undefined) drawPrimitive(chart, { kind: 'hline', price: s.invalidationPrice, dashed: true, color: palette.invalidation, label: `invalidation (${s.direction})` })
    }
    const observer = new ResizeObserver(() => chart.resize())
    observer.observe(container)
    return () => {
      observer.disconnect()
      dispose(container)
    }
  }, [data, scenarios, dark, active])
  return <div ref={el} style={{ height: CHART_HEIGHT + paneCount * PANE_HEIGHT, width: '100%' }} />
}

function fmt(x: unknown): string {
  return typeof x === 'number' && Number.isFinite(x) ? String(x) : '—'
}

function get(x: unknown, key: string): unknown {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>)[key] : undefined
}

const SHELL: CSSProperties = {
  border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.25))',
  borderRadius: 8,
  padding: 12,
  margin: '4px 0',
  fontSize: 12,
  lineHeight: 1.5,
}

function Fallback({ text, error }: { text: string; error: boolean }): JSX.Element {
  return (
    <div style={SHELL}>
      <pre style={{
        margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 12,
        color: error ? 'var(--dsw-alias-state-error-primary, #e0563f)' : 'inherit',
      }}>{text}</pre>
    </div>
  )
}

function annotationRow(a: ChartAnnotation, close: number, p: Palette): { key: string; color: string; label: string; where: string; distance: string; sources: string } | null {
  const sources = Array.isArray(a['sources']) ? a['sources'].filter((s): s is string => typeof s === 'string').join(' + ') : ''
  const label = str(a['label']) ?? a.type
  const color = roleColor(a['role'], p)
  const pct = (x: number): string => close === 0 ? '' : `${x >= close ? '+' : ''}${(((x - close) / close) * 100).toFixed(2)}%`
  if (a.type === 'level') {
    const price = num(a['price'])
    if (price === undefined) return null
    return { key: `level:${label}:${price}`, color, label, where: String(price), distance: pct(price), sources }
  }
  if (a.type === 'zone') {
    const low = num(a['low'])
    const high = num(a['high'])
    if (low === undefined || high === undefined) return null
    return { key: `zone:${label}:${low}`, color, label, where: `${low} – ${high}`, distance: pct((low + high) / 2), sources }
  }
  if (a.type === 'path') {
    const n = Array.isArray(a['points']) ? a['points'].length : 0
    return { key: `path:${label}`, color, label, where: `${n}-point path`, distance: '', sources }
  }
  const known = annotationRenderers.has(a.type)
  return { key: `x:${a.type}:${label}`, color: p.faint, label, where: known ? a.type : `${a.type} (no renderer installed)`, distance: '', sources }
}

export function ChartCard(props: ToolCallViewProps): JSX.Element {
  const { block, toolName } = props
  const dark = useDark()
  const [activeTf, setActiveTf] = useState(0)
  const [activeChips, setActiveChips] = useState<string[]>([])

  const payload = 'kind' in block && !block.isError ? readChartPayload(block.meta) : null
  const tf = payload === null
    ? undefined
    : payload.timeframes[Math.min(activeTf, payload.timeframes.length - 1)]
  const activeKey = useMemo(() => [...activeChips].sort().join(','), [activeChips])
  const activeList = useMemo(() => activeKey === '' ? [] : activeKey.split(','), [activeKey])
  const scenarios = useMemo(() => payload?.scenarios ?? [], [payload])

  if (!('kind' in block)) {
    return <div style={SHELL}>{toolName} …</div>
  }
  if (block.isError) {
    return <Fallback text={contentText(block.content) || `${toolName} failed`} error />
  }
  if (payload === null || tf === undefined) {
    return <Fallback text={contentText(block.content)} error={false} />
  }

  const last = tf.candles[tf.candles.length - 1]!
  const first = tf.candles[0]!
  const changePct = get(tf.indicators, 'changePct')
  const palette = dark ? DARK : LIGHT
  const toggle = (id: string): void =>
    setActiveChips(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  const chipRow = tf.indicators === null ? [] : CHIP_DEFS.flatMap((def) => {
    const { text, state } = def.label(tf.indicators!)
    if (typeof state !== 'string' || state === '') return []
    const togglable = def.indicator !== undefined && hasSeries(tf, def.indicator.figures)
    return [{ id: def.id, text: `${text} · ${state}`, togglable, on: activeChips.includes(def.id) }]
  })

  const rows = (tf.annotations ?? [])
    .map(a => annotationRow(a, last.close, palette))
    .filter((r): r is NonNullable<typeof r> => r !== null)

  return (
    <div style={SHELL}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <strong style={{ fontSize: 13 }}>{payload.symbol}</strong>
        <span style={{ color: palette.faint }}>{tf.timeframe} · {tf.candles.length} bars · {payload.provider}</span>
        <span>close {last.close}</span>
        {typeof changePct === 'number' && Number.isFinite(changePct)
          ? <span style={{ color: changePct >= 0 ? palette.up : palette.down }}>
              {changePct >= 0 ? '+' : ''}{changePct}%
            </span>
          : null}
        {payload.timeframes.length > 1
          ? <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              {payload.timeframes.map((t, i) => (
                <button
                  key={t.timeframe}
                  onClick={() => setActiveTf(i)}
                  style={{
                    border: `1px solid ${i === activeTf ? palette.text : palette.line}`,
                    background: 'transparent', color: 'inherit', borderRadius: 4,
                    padding: '1px 8px', fontSize: 11, cursor: 'pointer',
                  }}
                >{t.timeframe}</button>
              ))}
            </span>
          : null}
      </div>
      <Kline data={tf} scenarios={scenarios} dark={dark} active={activeList} />
      {chipRow.length > 0
        ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {chipRow.map(chip => chip.togglable
              ? <button
                  key={chip.id}
                  onClick={() => toggle(chip.id)}
                  aria-pressed={chip.on}
                  style={{
                    border: `1px solid ${chip.on ? palette.up : palette.line}`,
                    background: chip.on ? `${palette.up}22` : 'transparent',
                    color: chip.on ? palette.up : palette.text,
                    borderRadius: 99, padding: '1px 8px', fontSize: 11, cursor: 'pointer',
                  }}
                >{chip.text}</button>
              : <span
                  key={chip.id}
                  style={{
                    border: `1px solid ${palette.line}`, borderRadius: 99,
                    padding: '1px 8px', fontSize: 11, color: palette.faint,
                  }}
                >{chip.text}</span>)}
          </div>
        : null}
      {rows.length > 0
        ? <table style={{ width: '100%', marginTop: 10, borderCollapse: 'collapse', fontSize: 11.5 }}>
            <tbody>
              {rows.map(row => (
                <tr key={row.key} style={{ borderTop: `1px solid ${palette.line}` }}>
                  <td style={{ padding: '4px 8px 4px 0', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 99, background: row.color, marginRight: 6 }} />
                    {row.label}
                  </td>
                  <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{row.where}</td>
                  <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: palette.faint, fontVariantNumeric: 'tabular-nums' }}>{row.distance}</td>
                  <td style={{ padding: '4px 0 4px 8px', color: palette.faint }}>{row.sources}</td>
                </tr>
              ))}
            </tbody>
          </table>
        : null}
      {scenarios.length > 0
        ? <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
            {scenarios.map((s, i) => (
              <div
                key={i}
                style={{
                  borderLeft: `3px solid ${s.direction === 'bull' ? palette.up : palette.down}`,
                  background: `${s.direction === 'bull' ? palette.up : palette.down}11`,
                  borderRadius: 4, padding: '6px 10px',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 2 }}>
                  <span style={{ color: s.direction === 'bull' ? palette.up : palette.down }}>
                    {s.direction === 'bull' ? 'BULL' : 'BEAR'}
                  </span>
                  <span style={{
                    marginLeft: 6, fontSize: 10, letterSpacing: 0.5, color: palette.faint,
                    border: `1px solid ${palette.line}`, borderRadius: 3, padding: '0 4px',
                  }}>{s.stance === 'base' ? 'BASE' : 'ALT'}</span>
                  <span style={{ marginLeft: 8, fontWeight: 400 }}>{s.thesis}</span>
                </div>
                <div style={{ color: palette.faint, fontSize: 11 }}>
                  Trigger: {s.trigger}{s.triggerPrice !== undefined ? ` (${s.triggerPrice})` : ''}
                  {' · '}Invalidation: {s.invalidation}{s.invalidationPrice !== undefined ? ` (${s.invalidationPrice})` : ''}
                </div>
              </div>
            ))}
          </div>
        : null}
      <div style={{ color: palette.faint, marginTop: 6, fontSize: 11 }}>
        {first.time} … {last.time} · chips toggle indicator panes drawn from the exact per-bar series the model read · scenarios are research hypotheses, not recommendations
      </div>
    </div>
  )
}
