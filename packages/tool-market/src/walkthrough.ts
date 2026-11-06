/**
 * The walkthrough: an analysis told the way an analyst sitting beside the
 * reader tells it. A few short spoken lines per section, each one moving the
 * chart: point at a bar, circle it, draw a level, light up a zone. The model
 * authors the script; this module checks it against the bars and resolves
 * every anchor to a time and a value the client can draw.
 *
 * Anchors are the point. A mark names a bar and a field ("the high of
 * 2026-10-23") and the VALUE is read off the data here, so the model cannot
 * circle a number the bar never printed. A value it does state is checked,
 * and a wrong one fails the call with the bar where that number actually
 * occurs. A level can cite a checkable source too ("the lowest low since
 * 9/11"), which turns the claim behind it into arithmetic instead of prose.
 *
 * Everything is a type ALIAS, not an interface, for the same reason as
 * chart-payload.ts: the resolved payload rides `presentationMeta`, which must
 * be assignable to dsh's JsonValue.
 * @module
 */
import type { Candle } from '@dsh-trading/market-data'
import { ema } from './candle-indicators.js'
import { sma } from './indicators.js'
import { regimeSeries, roundSeries } from './chart-payload.js'

export const WALK_FIELDS = [
  'open', 'high', 'low', 'close', 'volume',
  'rsi14', 'stoch_k', 'stoch_d', 'adx', 'plus_di', 'minus_di', 'macd', 'macd_signal', 'macd_hist', 'mfi14',
  'sma20', 'sma50', 'sma200', 'ema20', 'bb_upper', 'bb_middle', 'bb_lower',
] as const
export type WalkField = (typeof WALK_FIELDS)[number]

/** Lower panes a section can open; the volume pane is always on screen. */
export const WALK_PANES = ['rsi', 'stoch', 'adx', 'macd', 'mfi'] as const
export type WalkPane = (typeof WALK_PANES)[number]

export const WALK_MARK_TYPES = ['circle', 'level', 'zone', 'path', 'arrow', 'span'] as const
export type WalkMarkType = (typeof WALK_MARK_TYPES)[number]

/** Where a mark is drawn: the candles, the volume bars, or the section's indicator pane. */
export type WalkSurface = 'price' | 'volume' | 'indicator'
export type WalkTone = 'up' | 'down' | 'neutral'

/** Series columns a pane draws, named as chart-payload's regime series names them. */
export const PANE_COLUMNS: Record<WalkPane, string[]> = {
  rsi: ['rsi14'],
  stoch: ['stoch_k', 'stoch_d'],
  adx: ['adx', 'plus_di', 'minus_di'],
  macd: ['macd_hist', 'macd', 'macd_signal'],
  mfi: ['mfi14'],
}

const PANE_OF_FIELD: Partial<Record<WalkField, WalkPane>> = {
  rsi14: 'rsi', stoch_k: 'stoch', stoch_d: 'stoch', adx: 'adx', plus_di: 'adx', minus_di: 'adx',
  macd: 'macd', macd_signal: 'macd', macd_hist: 'macd', mfi14: 'mfi',
}

/** Bars of history the indicator columns are computed over: market_snapshot's default window. */
export const WALK_INDICATOR_BARS = 300
export const MAX_WALK_LINES = 12
export const MAX_WALK_MARKS = 16
export const MAX_WALK_ASK = 3
const MAX_PATH_POINTS = 8
const MAX_AHEAD = 30

/* ── arguments, as the tool schema delivers them ──────────────────── */

export type WalkPointArg = { time?: string; field?: string; value?: number; ahead?: number; price?: number }
export type WalkSourceArg = { field: string; time?: string; stat?: string; from?: string; to?: string }
export type WalkMarkArg = {
  id: string
  type: string
  at?: WalkPointArg
  price?: number
  low?: number
  high?: number
  points?: WalkPointArg[]
  from?: string
  to?: string
  source?: WalkSourceArg
  why?: string
  label?: string
  tone?: string
  /** annotate_chart's vocabulary, accepted because models carry it over: support reads as up, resistance as down. */
  role?: string
  pane?: string
  keep?: boolean
}
export type WalkLineArg = {
  say: string
  draw?: string[]
  point?: string
  pointAt?: WalkPointArg
  focus?: string
  volume?: string[]
}
export type WalkthroughArgs = {
  symbol: string
  timeframe: string
  section: string
  from?: string
  pane?: string
  marks?: WalkMarkArg[]
  lines: WalkLineArg[]
  ask?: string[]
}

/* ── the resolved payload the client draws ────────────────────────── */

/** A bar-anchored point (bar open time in ms) or a projection `ahead` bars past the last one. */
export type WalkPoint = { t: number; v: number } | { ahead: number; v: number }

export type WalkMark = {
  id: string
  type: WalkMarkType
  surface: WalkSurface
  tone: WalkTone
  label?: string
  /** Stays faintly on the chart through later sections of the same walkthrough. */
  keep?: true
  at?: { t: number; v: number }
  price?: number
  low?: number
  high?: number
  points?: WalkPoint[]
  from?: number
  to?: number
}

export type WalkLine = {
  say: string
  draw?: string[]
  point?: string
  pointAt?: { t: number; v: number; surface: WalkSurface }
  focus?: string
  volume?: number[]
}

export type WalkthroughPayload = {
  kind: 'walkthrough'
  version: 1
  provider: string
  symbol: string
  timeframe: string
  section: string
  /** Bar open times (ms) of the first and last bar the section frames. */
  window: { from: number; to: number }
  pane?: WalkPane
  /** The pane's columns over the window, keyed by bar open time, rounded as the model read them. */
  series?: { t: number[]; cols: Record<string, (number | null)[]> }
  marks: WalkMark[]
  lines: WalkLine[]
  ask?: string[]
  close: number
}

/* ── helpers ──────────────────────────────────────────────────────── */

/** Strip control characters and cap length: model-authored text lands in a durable log and a DOM. */
function clean(s: string, cap: number): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap)
}

/** Round for display at the precision a reader quotes: cents above 1, five significant digits below. */
export function roundPrice(v: number): number {
  if (!Number.isFinite(v)) return v
  return Math.abs(v) >= 1 ? Math.round(v * 100) / 100 : Number(v.toPrecision(5))
}

function isField(x: unknown): x is WalkField {
  return typeof x === 'string' && (WALK_FIELDS as readonly string[]).includes(x)
}

function surfaceOf(field: WalkField): WalkSurface {
  if (field === 'volume') return 'volume'
  return PANE_OF_FIELD[field] !== undefined ? 'indicator' : 'price'
}

/** Close enough for a value the model quoted from a rounded read. */
function matches(field: WalkField, claimed: number, actual: number): boolean {
  if (field === 'volume') return Math.abs(claimed - actual) <= Math.abs(actual) * 0.01
  if (PANE_OF_FIELD[field] !== undefined) return Math.abs(claimed - actual) <= Math.max(0.06, Math.abs(actual) * 0.01)
  return Math.abs(claimed - actual) <= Math.max(0.011, Math.abs(actual) * 0.0006)
}

/**
 * The bars, their indicator columns, and lookups by time — everything the
 * resolver reads, computed once.
 */
class Bars {
  readonly times: number[]
  readonly intraday: boolean
  private readonly cols: Record<string, (number | null)[]>

  constructor(readonly candles: readonly Candle[]) {
    this.times = candles.map(c => Date.parse(c.time))
    const n = candles.length
    this.intraday = n > 1 && this.times[n - 1]! - this.times[n - 2]! < 20 * 3600_000
    const closes = candles.map(c => c.close)
    // Indicator columns over market_snapshot's window, so a value the model
    // read there resolves to the same rounded number here. Bars older than
    // the window have none, honestly.
    const start = Math.max(0, n - WALK_INDICATOR_BARS)
    const regime = regimeSeries(candles.slice(start))
    const pad = (col: (number | null)[]): (number | null)[] => [...new Array<null>(start).fill(null), ...col]
    this.cols = {}
    for (const [name, col] of Object.entries(regime)) this.cols[name] = pad(col)
    this.cols['sma20'] = roundSeries(sma(closes, 20), 2)
    this.cols['sma50'] = roundSeries(sma(closes, 50), 2)
    this.cols['sma200'] = roundSeries(sma(closes, 200), 2)
    this.cols['ema20'] = roundSeries(ema(closes, 20), 2)
  }

  get last(): number { return this.candles.length - 1 }

  /** Calendar label of a bar, the way the model names it. */
  label(i: number): string {
    const iso = new Date(this.times[i]!).toISOString()
    return this.intraday ? `${iso.slice(0, 16)}Z` : iso.slice(0, 10)
  }

  /**
   * The bar a time names: the last bar opening at or before it. A bare date
   * means that whole day, so on daily and weekly charts it lands on that
   * day's (or week's) bar, and on intraday charts on the day's last bar.
   */
  index(time: string, what: string): number {
    const t = /^\d{4}-\d{2}-\d{2}$/.test(time) ? Date.parse(`${time}T23:59:59.999Z`) : Date.parse(time)
    if (!Number.isFinite(t)) throw new Error(`${what}: '${time}' is not a date or ISO-8601 time`)
    if (t < this.times[0]!) throw new Error(`${what}: ${time} is before the first bar fetched (${this.label(0)})`)
    let lo = 0
    let hi = this.last
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.times[mid]! <= t) lo = mid
      else hi = mid - 1
    }
    const span = this.last > 0 ? this.times[this.last]! - this.times[this.last - 1]! : 0
    if (lo === this.last && t > this.times[this.last]! + Math.max(span, 86_400_000)) {
      throw new Error(`${what}: ${time} is after the last bar (${this.label(this.last)})`)
    }
    return lo
  }

  value(i: number, field: WalkField): number | null {
    const c = this.candles[i]!
    switch (field) {
      case 'open': return roundPrice(c.open)
      case 'high': return roundPrice(c.high)
      case 'low': return roundPrice(c.low)
      case 'close': return roundPrice(c.close)
      case 'volume': return c.volume
      default: return this.cols[field]?.[i] ?? null
    }
  }

  /** The first bar in [from, to] whose field matches a quoted value, for an error's hint. */
  find(field: WalkField, value: number, from = 0, to = this.last): number | null {
    for (let i = from; i <= to; i++) {
      const v = this.value(i, field)
      if (v !== null && matches(field, value, v)) return i
    }
    return null
  }

  column(name: string, from: number): (number | null)[] {
    return (this.cols[name] ?? []).slice(from)
  }
}

/** The price band a level may sit in: annotate_chart's gate, widened for projections. */
function priceGate(bars: Bars, wide: boolean): { floor: number; ceil: number } {
  let lo = Infinity
  let hi = -Infinity
  for (const c of bars.candles) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high) }
  return wide ? { floor: lo * 0.5, ceil: hi * 2 } : { floor: lo * 0.7, ceil: hi * 1.3 }
}

/* ── the resolver ─────────────────────────────────────────────────── */

/**
 * Check one walkthrough section against the bars and resolve it for drawing.
 * @param args - the section as the model wrote it.
 * @param candles - ascending bars of `args.timeframe`, ending at the latest.
 * @param provider - id of the provider that served the bars.
 * @returns the payload the client performs, and the summary the model reads.
 * @throws an Error whose message tells the model exactly what to fix.
 */
export function resolveWalkthrough(
  args: WalkthroughArgs,
  candles: readonly Candle[],
  provider: string,
): { payload: WalkthroughPayload; summary: string } {
  if (candles.length < 5) throw new Error(`not enough bars for ${args.symbol} @ ${args.timeframe} to tell a section on`)
  const bars = new Bars(candles)
  const section = clean(args.section ?? '', 24)
  if (section === '') throw new Error('section needs a short title, e.g. "结论" or "双顶"')

  const lineArgs = args.lines ?? []
  if (lineArgs.length === 0) throw new Error('a section needs at least one line')
  if (lineArgs.length > MAX_WALK_LINES) throw new Error(`too many lines (${lineArgs.length} > ${MAX_WALK_LINES}): split the section, or say less`)
  const markArgs = args.marks ?? []
  if (markArgs.length > MAX_WALK_MARKS) throw new Error(`too many marks (${markArgs.length} > ${MAX_WALK_MARKS}): a section points at a few things`)

  const fromIdx = args.from !== undefined ? bars.index(args.from, 'from') : Math.max(0, bars.last - 59)
  if (bars.last - fromIdx < 4) throw new Error(`from ${args.from} leaves fewer than 5 bars on screen; start earlier`)

  let pane: WalkPane | undefined
  if (args.pane !== undefined) {
    if (!(WALK_PANES as readonly string[]).includes(args.pane)) throw new Error(`pane must be one of ${WALK_PANES.join(', ')}`)
    pane = args.pane as WalkPane
  }
  /** A field on an indicator pane fixes the section's pane, and every such field must agree. */
  const usePane = (field: WalkField, what: string): void => {
    const wanted = PANE_OF_FIELD[field]
    if (wanted === undefined) return
    if (pane === undefined) pane = wanted
    else if (pane !== wanted) throw new Error(`${what}: ${field} is drawn on the ${wanted} pane, but this section shows ${pane}; one indicator pane per section`)
  }

  const checks: string[] = []
  /** Resolve a bar anchor, checking a quoted value. */
  const anchor = (p: WalkPointArg | undefined, what: string): { i: number; field: WalkField; v: number } => {
    if (p === undefined || p.time === undefined) throw new Error(`${what} needs a bar: { time, field }`)
    if (!isField(p.field)) throw new Error(`${what}: field must be one of ${WALK_FIELDS.join(', ')}`)
    const i = bars.index(p.time, what)
    const v = bars.value(i, p.field)
    if (v === null) throw new Error(`${what}: ${p.field} has no value at ${bars.label(i)} (indicators cover the last ${WALK_INDICATOR_BARS} bars)`)
    if (p.value !== undefined) {
      if (!Number.isFinite(p.value) || !matches(p.field, p.value, v)) {
        const at = Number.isFinite(p.value) ? bars.find(p.field, p.value) : null
        throw new Error(
          `${what}: the ${p.field} of ${bars.label(i)} is ${v}, not ${p.value}`
          + (at !== null ? ` (${p.value} is the ${p.field} of ${bars.label(at)})` : '')
          + '. Fix the time or the value.',
        )
      }
    }
    usePane(p.field, what)
    return { i, field: p.field, v }
  }

  const ids = new Set<string>()
  const marks: WalkMark[] = []
  for (const [k, m] of markArgs.entries()) {
    const id = typeof m.id === 'string' ? m.id.trim() : ''
    const what = `mark '${id || `#${k + 1}`}'`
    if (!/^[A-Za-z0-9_-]{1,24}$/.test(id)) throw new Error(`${what}: id must be 1–24 letters, digits, _ or -`)
    if (ids.has(id)) throw new Error(`${what}: duplicate id`)
    ids.add(id)
    if (!(WALK_MARK_TYPES as readonly string[]).includes(m.type)) throw new Error(`${what}: type must be one of ${WALK_MARK_TYPES.join(', ')}`)
    const type = m.type as WalkMarkType
    const tone: WalkTone = m.tone === 'up' || m.tone === 'down' ? m.tone
      : m.role === 'support' ? 'up' : m.role === 'resistance' ? 'down' : 'neutral'
    const label = m.label !== undefined ? clean(m.label, 40) : ''
    const base = { id, type, tone, ...label !== '' ? { label } : {}, ...m.keep === true ? { keep: true as const } : {} }

    if (type === 'circle') {
      const a = anchor(m.at, what)
      marks.push({ ...base, surface: surfaceOf(a.field), at: { t: bars.times[a.i]!, v: a.v } })
      checks.push(`${id} = ${a.field} ${bars.label(a.i)} ${a.v}`)
    } else if (type === 'level') {
      const price = m.price
      if (price === undefined || !Number.isFinite(price)) throw new Error(`${what}: a level needs a price`)
      const surface: WalkSurface = m.pane === 'volume' ? 'volume' : m.pane === 'indicator' ? 'indicator' : 'price'
      if (surface === 'price') {
        const gate = priceGate(bars, false)
        if (price < gate.floor || price > gate.ceil) {
          throw new Error(`${what}: ${price} is outside the plausible range of these bars (${roundPrice(gate.floor)} … ${roundPrice(gate.ceil)}); anchor on prices you read`)
        }
      }
      if (m.source === undefined && (m.why === undefined || clean(m.why, 120) === '')) {
        throw new Error(`${what}: say where ${price} comes from, as a checkable source { field, time | stat+from } or at least a why`)
      }
      if (m.source !== undefined) checks.push(`${id} ${price} = ${checkSource(bars, m.source, price, what)} ✓`)
      marks.push({ ...base, surface, price: roundPrice(price) })
    } else if (type === 'zone') {
      const { low, high } = m
      if (low === undefined || high === undefined || !Number.isFinite(low) || !Number.isFinite(high) || low >= high) {
        throw new Error(`${what}: a zone needs low < high`)
      }
      const gate = priceGate(bars, false)
      if (low < gate.floor || high > gate.ceil) throw new Error(`${what}: ${low}–${high} is outside the plausible range of these bars`)
      if (m.why === undefined || clean(m.why, 120) === '') throw new Error(`${what}: say what makes ${low}–${high} a zone (why)`)
      marks.push({ ...base, surface: 'price', low: roundPrice(low), high: roundPrice(high) })
    } else if (type === 'path' || type === 'arrow') {
      const raw = m.points ?? []
      if (raw.length < 2 || raw.length > MAX_PATH_POINTS) throw new Error(`${what}: needs 2–${MAX_PATH_POINTS} points`)
      const gate = priceGate(bars, true)
      let surface: WalkSurface | undefined
      let projecting = false
      const points: WalkPoint[] = raw.map((p, j) => {
        const pw = `${what} point ${j + 1}`
        if (p.ahead !== undefined) {
          if (!Number.isInteger(p.ahead) || p.ahead < 1 || p.ahead > MAX_AHEAD) throw new Error(`${pw}: ahead must be 1–${MAX_AHEAD} bars`)
          if (p.price === undefined || !Number.isFinite(p.price) || p.price < gate.floor || p.price > gate.ceil) throw new Error(`${pw}: a projection needs a plausible price`)
          projecting = true
          return { ahead: p.ahead, v: roundPrice(p.price) }
        }
        if (projecting) throw new Error(`${pw}: bar points come before projections`)
        const a = anchor(p, pw)
        const s = surfaceOf(a.field)
        if (surface !== undefined && s !== surface) throw new Error(`${what}: every point must be on the same pane`)
        surface = s
        return { t: bars.times[a.i]!, v: a.v }
      })
      if (!('t' in points[0]!)) throw new Error(`${what}: start the path on a bar, then project with ahead`)
      marks.push({ ...base, surface: surface ?? 'price', points })
    } else {
      if (m.from === undefined) throw new Error(`${what}: a span needs from (and optionally to)`)
      const a = bars.index(m.from, `${what} from`)
      const b = m.to !== undefined ? bars.index(m.to, `${what} to`) : bars.last
      if (b < a) throw new Error(`${what}: to is before from`)
      marks.push({ ...base, surface: 'price', from: bars.times[a]!, to: bars.times[b]! })
    }
  }

  const drawn = new Set<string>()
  const lines: WalkLine[] = lineArgs.map((l, k) => {
    const what = `line ${k + 1}`
    const say = clean(l.say ?? '', 160)
    if (say === '') throw new Error(`${what} says nothing`)
    const draw = (l.draw ?? []).map(id => {
      if (!ids.has(id)) throw new Error(`${what}: draws '${id}', which is not a mark of this section`)
      drawn.add(id)
      return id
    })
    let pointAt: WalkLine['pointAt']
    if (l.pointAt !== undefined) {
      const a = anchor(l.pointAt, `${what} pointAt`)
      pointAt = { t: bars.times[a.i]!, v: a.v, surface: surfaceOf(a.field) }
    }
    const volume = (l.volume ?? []).map(time => bars.times[bars.index(time, `${what} volume`)]!)
    const point = typeof l.point === 'string' && l.point.trim() !== '' ? l.point.trim() : undefined
    const focus = typeof l.focus === 'string' && l.focus.trim() !== '' ? l.focus.trim() : undefined
    return {
      say,
      ...draw.length > 0 ? { draw } : {},
      ...point !== undefined ? { point } : {},
      ...pointAt !== undefined ? { pointAt } : {},
      ...focus !== undefined ? { focus } : {},
      ...volume.length > 0 ? { volume } : {},
    }
  })
  for (const id of ids) {
    if (!drawn.has(id)) throw new Error(`mark '${id}' is never drawn: add it to the draw list of the line that talks about it`)
  }

  const ask = (args.ask ?? []).map(a => clean(a, 30)).filter(a => a !== '')
  if (ask.length > MAX_WALK_ASK) throw new Error(`offer at most ${MAX_WALK_ASK} replies`)

  const finalPane = pane
  const series = finalPane !== undefined
    ? {
        t: bars.times.slice(fromIdx),
        cols: Object.fromEntries(PANE_COLUMNS[finalPane].map(name => [name, bars.column(name, fromIdx)])),
      }
    : undefined

  const payload: WalkthroughPayload = {
    kind: 'walkthrough',
    version: 1,
    provider,
    symbol: args.symbol,
    timeframe: args.timeframe,
    section,
    window: { from: bars.times[fromIdx]!, to: bars.times[bars.last]! },
    ...finalPane !== undefined ? { pane: finalPane } : {},
    ...series !== undefined ? { series } : {},
    marks,
    lines,
    ...ask.length > 0 ? { ask } : {},
    close: roundPrice(candles[bars.last]!.close),
  }

  const summary = [
    `Section «${section}» is being told on ${args.symbol} ${args.timeframe} (${bars.label(fromIdx)} → ${bars.label(bars.last)}), ${lines.length} line(s).`,
    checks.length > 0 ? ` Read off the bars: ${checks.join('; ')}.` : '',
    ' The reader hears these lines with the chart moving; do not repeat them as text.',
    ask.length > 0
      ? ` You offered replies (${ask.join(' / ')}). End your turn now: no more tool calls and no closing text, the reader already sees the question.`
      : ' Continue with the next section, or end your turn.',
  ].join('')
  return { payload, summary }
}

/**
 * Check a level against its stated source and say what it equals.
 * @returns a short description of the source, for the summary.
 * @throws when the price is not what the source says.
 */
function checkSource(bars: Bars, source: WalkSourceArg, price: number, what: string): string {
  if (!isField(source.field)) throw new Error(`${what} source: field must be one of ${WALK_FIELDS.join(', ')}`)
  const field = source.field
  if (source.stat === 'min' || source.stat === 'max') {
    if (source.from === undefined) throw new Error(`${what} source: ${source.stat} needs from (and optionally to)`)
    const a = bars.index(source.from, `${what} source from`)
    const b = source.to !== undefined ? bars.index(source.to, `${what} source to`) : bars.last
    let best: number | null = null
    let at = a
    for (let i = a; i <= b; i++) {
      const v = bars.value(i, field)
      if (v === null) continue
      if (best === null || (source.stat === 'min' ? v < best : v > best)) { best = v; at = i }
    }
    if (best === null) throw new Error(`${what} source: no ${field} values between ${bars.label(a)} and ${bars.label(b)}`)
    const range = `${bars.label(a)} → ${bars.label(b)}`
    if (!matches(field, price, best)) {
      throw new Error(`${what}: the ${source.stat === 'min' ? 'lowest' : 'highest'} ${field} over ${range} is ${best} (${bars.label(at)}), not ${price}`)
    }
    return `${source.stat} ${field} ${range} (${bars.label(at)})`
  }
  const i = source.time !== undefined ? bars.index(source.time, `${what} source`) : bars.last
  const v = bars.value(i, field)
  if (v === null) throw new Error(`${what} source: ${field} has no value at ${bars.label(i)}`)
  if (!matches(field, price, v)) {
    const hint = bars.find(field, price)
    throw new Error(
      `${what}: the ${field} of ${bars.label(i)} is ${v}, not ${price}`
      + (hint !== null ? ` (${price} is the ${field} of ${bars.label(hint)})` : ''),
    )
  }
  return `${field} ${bars.label(i)}`
}
