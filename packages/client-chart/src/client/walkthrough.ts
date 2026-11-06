/**
 * The card's copy of the walkthrough contract, read defensively at the trust
 * boundary like payload.ts: `block.meta` is whatever some tool wrote into the
 * session log, possibly by an older or newer @dsh-trading/tool-market.
 * Producer lives at packages/tool-market/src/walkthrough.ts.
 * @module
 */

export type WalkSurface = 'price' | 'volume' | 'indicator'
export type WalkTone = 'up' | 'down' | 'neutral'
export type WalkPane = 'rsi' | 'stoch' | 'adx' | 'macd' | 'mfi'
export type WalkMarkType = 'circle' | 'level' | 'zone' | 'path' | 'arrow' | 'span'

/** A bar-anchored point (bar open time, ms) or a projection `ahead` bars past the last one. */
export type WalkPoint = { t: number; v: number } | { ahead: number; v: number }

export type WalkMark = {
  id: string
  type: WalkMarkType
  surface: WalkSurface
  tone: WalkTone
  label?: string
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

export type Walkthrough = {
  provider: string
  symbol: string
  timeframe: string
  section: string
  window: { from: number; to: number }
  pane?: WalkPane
  series?: { t: number[]; cols: Record<string, (number | null)[]> }
  marks: WalkMark[]
  lines: WalkLine[]
  ask?: string[]
  close: number
}

const PANES: readonly string[] = ['rsi', 'stoch', 'adx', 'macd', 'mfi']
const TYPES: readonly string[] = ['circle', 'level', 'zone', 'path', 'arrow', 'span']

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
const str = (x: unknown, cap: number): string | undefined =>
  typeof x === 'string' && x.trim() !== '' ? x.slice(0, cap) : undefined
const surfaceOf = (x: unknown): WalkSurface => x === 'volume' || x === 'indicator' ? x : 'price'

function readPoint(x: unknown): WalkPoint | null {
  if (!isRecord(x) || !num(x['v'])) return null
  if (num(x['t'])) return { t: x['t'], v: x['v'] }
  if (num(x['ahead'])) return { ahead: x['ahead'], v: x['v'] }
  return null
}

function readMark(x: unknown): WalkMark | null {
  if (!isRecord(x) || typeof x['id'] !== 'string' || typeof x['type'] !== 'string' || !TYPES.includes(x['type'])) return null
  const type = x['type'] as WalkMarkType
  const tone: WalkTone = x['tone'] === 'up' || x['tone'] === 'down' ? x['tone'] : 'neutral'
  const label = str(x['label'], 60)
  const mark: WalkMark = {
    id: x['id'].slice(0, 24), type, surface: surfaceOf(x['surface']), tone,
    ...label !== undefined ? { label } : {},
    ...x['keep'] === true ? { keep: true as const } : {},
  }
  if (type === 'circle') {
    const at = readPoint(x['at'])
    if (at === null || !('t' in at)) return null
    return { ...mark, at }
  }
  if (type === 'level') return num(x['price']) ? { ...mark, price: x['price'] } : null
  if (type === 'zone') return num(x['low']) && num(x['high']) && x['low'] < x['high'] ? { ...mark, low: x['low'], high: x['high'] } : null
  if (type === 'span') return num(x['from']) && num(x['to']) ? { ...mark, from: x['from'], to: x['to'] } : null
  const points = Array.isArray(x['points']) ? x['points'].map(readPoint) : []
  if (points.length < 2 || points.some(p => p === null)) return null
  return { ...mark, points: points as WalkPoint[] }
}

function readLine(x: unknown): WalkLine | null {
  if (!isRecord(x)) return null
  const say = str(x['say'], 200)
  if (say === undefined) return null
  const ids = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').slice(0, 16) : []
  const draw = ids(x['draw'])
  const point = str(x['point'], 24)
  const focus = str(x['focus'], 24)
  const pa = x['pointAt']
  const pointAt = isRecord(pa) && num(pa['t']) && num(pa['v']) ? { t: pa['t'], v: pa['v'], surface: surfaceOf(pa['surface']) } : undefined
  const volume = Array.isArray(x['volume']) ? x['volume'].filter(num).slice(0, 12) : []
  return {
    say,
    ...draw.length > 0 ? { draw } : {},
    ...point !== undefined ? { point } : {},
    ...pointAt !== undefined ? { pointAt } : {},
    ...focus !== undefined ? { focus } : {},
    ...volume.length > 0 ? { volume } : {},
  }
}

/** Null when meta is absent, foreign, from another version, or malformed. */
export function readWalkthrough(meta: unknown): Walkthrough | null {
  if (!isRecord(meta) || meta['kind'] !== 'walkthrough' || meta['version'] !== 1) return null
  const provider = str(meta['provider'], 64)
  const symbol = str(meta['symbol'], 64)
  const timeframe = str(meta['timeframe'], 8)
  const section = str(meta['section'], 40)
  const w = meta['window']
  if (provider === undefined || symbol === undefined || timeframe === undefined || section === undefined) return null
  if (!isRecord(w) || !num(w['from']) || !num(w['to']) || !num(meta['close'])) return null
  const lines = Array.isArray(meta['lines']) ? meta['lines'].map(readLine).filter((l): l is WalkLine => l !== null) : []
  if (lines.length === 0) return null
  const marks = Array.isArray(meta['marks']) ? meta['marks'].map(readMark).filter((m): m is WalkMark => m !== null) : []
  const pane = typeof meta['pane'] === 'string' && PANES.includes(meta['pane']) ? meta['pane'] as WalkPane : undefined
  const s = meta['series']
  const series = pane !== undefined && isRecord(s) && Array.isArray(s['t']) && isRecord(s['cols'])
    ? {
        t: s['t'].filter(num),
        cols: Object.fromEntries(Object.entries(s['cols']).filter(([, c]) => Array.isArray(c))
          .map(([k, c]) => [k, (c as unknown[]).map(v => num(v) ? v : null)])),
      }
    : undefined
  const ask = Array.isArray(meta['ask']) ? meta['ask'].map(a => str(a, 40)).filter((a): a is string => a !== undefined).slice(0, 3) : []
  return {
    provider, symbol, timeframe, section,
    window: { from: w['from'], to: w['to'] },
    ...pane !== undefined ? { pane } : {},
    ...series !== undefined && series.cols !== undefined ? { series } : {},
    marks, lines,
    ...ask.length > 0 ? { ask } : {},
    close: meta['close'],
  }
}

/** One run of a spoken line: plain words, words a mark explains, or bold. */
export type SaySegment = { text: string; mark?: string; bold?: true }

/**
 * Split a line into runs. `[[id|words]]` ties words to a mark so the reader
 * can hover them to see it; `**words**` is bold. Everything else, including a
 * malformed token, stays literal text: this is rendered as text, never HTML.
 * @param say - the line as the model wrote it.
 * @returns its runs, in order.
 */
export function parseSay(say: string): SaySegment[] {
  const out: SaySegment[] = []
  const re = /\[\[([A-Za-z0-9_-]{1,24})\|([^\]]{1,80})\]\]|\*\*([^*]{1,80})\*\*/g
  let last = 0
  for (let m = re.exec(say); m !== null; m = re.exec(say)) {
    if (m.index > last) out.push({ text: say.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ text: m[2]!, mark: m[1] })
    else out.push({ text: m[3]!, bold: true })
    last = m.index + m[0].length
  }
  if (last < say.length) out.push({ text: say.slice(last) })
  return out
}

/** The line as plain words, for pacing and for screen readers. */
export function plainSay(say: string): string {
  return parseSay(say).map(s => s.text).join('')
}
