/**
 * The walkthrough player: turns the sections the model wrote into a
 * conversation that happens in time, and tells the chart what to show.
 *
 * The model writes a whole section at once (one tool call), much faster than
 * anyone reads it. Shown at once, that is a report again. So a section that
 * arrives live is SPOKEN: a short typing pause, one line, time to read it,
 * the next line, and each line moves the chart as it appears. Sections queue
 * behind each other, so the model can keep writing while the reader is still
 * on the conclusion. A section that is history (a reload, an old session)
 * shows settled, all at once, and is never replayed at you.
 *
 * Module-level and framework-free on purpose, like latest.ts: the cards in
 * the chat and the chart column are separate slot trees with no common
 * parent, and the rules here (pacing, replay, what is on the board at a given
 * line) are plain functions a test can drive with fake timers.
 * @module
 */
import { plainSay } from './walkthrough.js'
import type { WalkMark, WalkPane, WalkSurface, Walkthrough } from './walkthrough.js'

export type LessonSection = { callId: string; time: number; data: Walkthrough }
export type Cursor = { callId: string; line: number }

/**
 * - `idle`: nothing left to say; the chart shows the newest line.
 * - `live`: speaking, on a timer.
 * - `paused`: the reader asked for quiet, or moved the chart to look.
 * - `replay`: the reader clicked an earlier line; the chart shows that moment.
 */
export type LessonMode = 'idle' | 'live' | 'paused' | 'replay'

export type BoardMark = WalkMark & {
  /** `faint`: carried over from an earlier section as a reminder. */
  state: 'on' | 'faint'
  /** Drawn by the line on screen right now, so it animates in. */
  fresh: boolean
  /** Re-lit by the line on screen right now. */
  flash: boolean
}

export type PointerTarget = { mark: string } | { t: number; v: number; surface: WalkSurface }

/** Everything the chart shows for one line of one section. */
export type Board = {
  callId: string
  /** Identity of the beat; changes on every line, which is what lets marks animate once. */
  beat: string
  provider: string
  symbol: string
  timeframe: string
  frame: { from: number; pad: number }
  pane?: WalkPane
  series?: Walkthrough['series']
  marks: BoardMark[]
  pointer: PointerTarget | null
  /** Bars whose volume is spotlit; the rest dim. */
  volume: number[] | null
  /** MA periods to draw: a far-off SMA200 would squash the bars a daily section is about. */
  ma: number[]
  hot: string | null
}

export type LessonSnapshot = {
  mode: LessonMode
  /** Lines visible per section; a section absent here shows all of its lines. */
  shown: ReadonlyMap<string, number>
  cursor: Cursor | null
  /** The section whose card shows the typing dot. */
  typing: string | null
  /** Paused because the reader moved the chart; the card offers to carry on. */
  look: boolean
  /** Newest section that offers replies and has said all of its lines. */
  asking: string | null
  /** Section the chart is on and how it is speaking, for the column's pill. */
  section: string | null
  board: Board | null
}

/** A section counts as live when it landed this recently: older ones are history. */
export const LIVE_WINDOW_MS = 45_000

const typeMs = (chars: number): number => Math.max(420, Math.min(950, chars * 26))
const readMs = (chars: number): number => Math.max(1100, Math.min(3600, chars * 70))

const PERFORMED_KEY = 'dsh-trading:walkthrough-performed'

function readPerformed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(PERFORMED_KEY)
    const list = raw === null ? [] : JSON.parse(raw)
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function writePerformed(ids: Set<string>): void {
  try {
    sessionStorage.setItem(PERFORMED_KEY, JSON.stringify([...ids].slice(-200)))
  } catch {
    // A tab that cannot store this will speak a section again after a reload; acceptable.
  }
}

const sameSymbol = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase()

/**
 * What the chart shows at a cursor: the section's marks drawn so far, marks
 * kept from earlier sections of the same instrument (faint), marks re-lit by
 * `focus`, where the pointer rests, and which volume bars are spotlit.
 * @param sections - every section seen, by call id.
 * @param cursor - the line on the chart.
 * @param hot - a mark the reader is hovering in the text.
 * @returns the board, or null when the cursor names nothing.
 */
export function boardAt(sections: ReadonlyMap<string, LessonSection>, cursor: Cursor | null, hot: string | null): Board | null {
  if (cursor === null) return null
  const sec = sections.get(cursor.callId)
  if (sec === undefined) return null
  const data = sec.data
  const upto = data.lines.slice(0, Math.min(cursor.line, data.lines.length - 1) + 1)
  const now = upto[upto.length - 1]
  if (now === undefined) return null

  // Earlier sections about the same instrument, oldest first, so a later
  // definition of an id wins.
  const earlier = [...sections.values()]
    .filter(s => s.time < sec.time && s.data.provider === data.provider && sameSymbol(s.data.symbol, data.symbol))
    .sort((a, b) => a.time - b.time)
  const byId = new Map<string, WalkMark>()
  for (const s of earlier) for (const m of s.data.marks) byId.set(m.id, m)
  const own = new Map(data.marks.map(m => [m.id, m]))
  const find = (id: string): WalkMark | undefined => own.get(id) ?? byId.get(id)

  const drawn = new Set(upto.flatMap(l => l.draw ?? []))
  const focused = new Set(upto.map(l => l.focus).filter((f): f is string => f !== undefined))
  const fresh = new Set(now.draw ?? [])

  const marks: BoardMark[] = []
  const placed = new Set<string>()
  for (const m of data.marks) {
    if (!drawn.has(m.id)) continue
    marks.push({ ...m, state: 'on', fresh: fresh.has(m.id), flash: now.focus === m.id })
    placed.add(m.id)
  }
  for (const id of focused) {
    const m = find(id)
    if (m === undefined || placed.has(id)) continue
    marks.push({ ...m, state: 'on', fresh: false, flash: now.focus === id })
    placed.add(id)
  }
  if (data.timeframe !== '1w') {
    for (const m of byId.values()) {
      if (m.keep !== true || placed.has(m.id)) continue
      marks.push({ ...m, state: 'faint', fresh: false, flash: false })
      placed.add(m.id)
    }
  }

  let pointer: PointerTarget | null = null
  for (let i = upto.length - 1; i >= 0 && pointer === null; i--) {
    const l = upto[i]!
    if (l.pointAt !== undefined) pointer = l.pointAt
    else if (l.point !== undefined && find(l.point) !== undefined) pointer = { mark: l.point }
  }
  let volume: number[] | null = null
  for (let i = upto.length - 1; i >= 0 && volume === null; i--) volume = upto[i]!.volume ?? null

  const projects = marks.some(m => (m.points ?? []).some(p => 'ahead' in p))
  return {
    callId: sec.callId,
    beat: `${sec.callId}:${upto.length - 1}`,
    provider: data.provider,
    symbol: data.symbol,
    timeframe: data.timeframe,
    frame: { from: data.window.from, pad: projects ? 220 : 72 },
    ...data.pane !== undefined ? { pane: data.pane } : {},
    ...data.series !== undefined ? { series: data.series } : {},
    marks,
    pointer,
    volume,
    ma: data.timeframe === '1w' ? [20, 50, 200] : [20, 50],
    hot: hot !== null && find(hot) !== undefined ? hot : null,
  }
}

/** The player. One per page; see {@link lesson}. */
export class LessonPlayer {
  private readonly sections = new Map<string, LessonSection>()
  private queue: string[] = []
  private performing: string | null = null
  private readonly shown = new Map<string, number>()
  private cursor: Cursor | null = null
  private liveCursor: Cursor | null = null
  private mode: LessonMode = 'idle'
  private typing: string | null = null
  private look = false
  private hot: string | null = null
  private readonly answered = new Set<string>()
  private performed: Set<string> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: (() => void) | null = null
  private readonly listeners = new Set<() => void>()
  private snapshot: LessonSnapshot = this.build()

  /**
   * A card saw its section. Live sections queue to be spoken; history shows
   * settled and, if newest, puts the chart on its last line.
   * @param callId - the tool call's id.
   * @param time - when the result was logged (ms).
   * @param data - the resolved section.
   * @param live - whether it landed just now.
   */
  register(callId: string, time: number, data: Walkthrough, live: boolean): void {
    if (this.sections.has(callId)) return
    this.sections.set(callId, { callId, time, data })
    this.performed ??= readPerformed()
    if (live && !this.performed.has(callId)) {
      this.shown.set(callId, 0)
      this.queue.push(callId)
      if (this.mode === 'idle') {
        this.mode = 'live'
        this.later(250, () => this.step())
      }
    } else if (this.performing === null && this.queue.length === 0 && this.mode !== 'replay') {
      const cur = this.cursor === null ? undefined : this.sections.get(this.cursor.callId)
      if (cur === undefined || cur.time <= time) this.cursor = { callId, line: data.lines.length - 1 }
    }
    this.notify()
  }

  /** Say whatever is next now instead of waiting: a click on the typing dot, or the → key. */
  hurry(): void {
    if (this.mode === 'replay') { this.backToLive(); return }
    if (this.mode === 'paused') { this.resume(); return }
    const run = this.pending
    if (run === null) return
    clearTimeout(this.timer)
    this.pending = null
    run()
  }

  /**
   * Stop talking.
   * @param look - the reader moved the chart to look for themselves.
   */
  pause(look = false): void {
    if (this.mode !== 'live') return
    this.halt()
    this.mode = 'paused'
    this.look = look
    this.notify()
  }

  resume(): void {
    if (this.mode === 'replay' && this.liveCursor !== null) this.cursor = this.liveCursor
    this.liveCursor = null
    this.look = false
    this.mode = this.performing !== null || this.queue.length > 0 ? 'live' : 'idle'
    if (this.mode === 'live') this.later(300, () => this.step())
    this.notify()
  }

  /** Show the chart as it was when an earlier line was said. */
  replay(callId: string, line: number): void {
    if (!this.sections.has(callId)) return
    if (this.mode === 'live') this.halt()
    if (this.mode !== 'replay') this.liveCursor = this.cursor
    this.mode = 'replay'
    this.look = false
    this.cursor = { callId, line }
    this.notify()
  }

  backToLive(): void {
    this.resume()
  }

  /** Show every line now: for a reader who would rather read than listen. */
  skipAll(): void {
    this.halt()
    const rest = [...this.performing !== null ? [this.performing] : [], ...this.queue]
    for (const id of rest) this.finish(id)
    this.performing = null
    this.queue = []
    const last = rest.at(-1)
    if (last !== undefined) this.cursor = { callId: last, line: this.sections.get(last)!.data.lines.length - 1 }
    else if (this.mode === 'replay' && this.liveCursor !== null) this.cursor = this.liveCursor
    this.liveCursor = null
    this.mode = 'idle'
    this.look = false
    this.notify()
  }

  /** Hand the chart back: every line shows, and nothing is drawn until a line is clicked or a new section lands. */
  dismiss(): void {
    this.skipAll()
    this.cursor = null
    this.notify()
  }

  /** The reader tapped a reply: the section stops offering it. */
  answer(callId: string): void {
    this.answered.add(callId)
    this.notify()
  }

  setHot(id: string | null): void {
    if (id === this.hot) return
    this.hot = id
    this.notify()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot(): LessonSnapshot {
    return this.snapshot
  }

  /* ── internals ─────────────────────────────────────────── */

  private step(): void {
    if (this.mode !== 'live') return
    if (this.performing === null) {
      this.performing = this.queue.shift() ?? null
      if (this.performing === null) {
        this.mode = 'idle'
        this.notify()
        return
      }
    }
    const callId = this.performing
    const lines = this.sections.get(callId)!.data.lines
    const k = this.shown.get(callId) ?? lines.length
    if (k >= lines.length) {
      this.finish(callId)
      this.performing = null
      this.later(600, () => this.step())
      this.notify()
      return
    }
    const chars = plainSay(lines[k]!.say).length
    this.typing = callId
    this.notify()
    this.later(typeMs(chars), () => {
      this.typing = null
      this.shown.set(callId, k + 1)
      this.cursor = { callId, line: k }
      this.notify()
      this.later(readMs(chars), () => this.step())
    })
  }

  private finish(callId: string): void {
    this.shown.delete(callId)
    this.performed ??= readPerformed()
    this.performed.add(callId)
    writePerformed(this.performed)
  }

  private halt(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending = null
    this.typing = null
  }

  private later(ms: number, run: () => void): void {
    clearTimeout(this.timer)
    this.pending = run
    this.timer = setTimeout(() => {
      this.pending = null
      run()
    }, ms)
  }

  private build(): LessonSnapshot {
    let asking: string | null = null
    let newest: LessonSection | undefined
    for (const s of this.sections.values()) if (newest === undefined || s.time > newest.time) newest = s
    if (newest !== undefined && newest.data.ask !== undefined && !this.answered.has(newest.callId)
      && !this.shown.has(newest.callId) && this.performing === null && this.queue.length === 0) {
      asking = newest.callId
    }
    const board = boardAt(this.sections, this.cursor, this.hot)
    return {
      mode: this.mode,
      shown: new Map(this.shown),
      cursor: this.cursor,
      typing: this.typing,
      look: this.look,
      asking,
      section: this.cursor === null ? null : this.sections.get(this.cursor.callId)?.data.section ?? null,
      board,
    }
  }

  private notify(): void {
    this.snapshot = this.build()
    for (const listener of this.listeners) listener()
  }
}

/** The page's player, shared by every walkthrough card and the chart column. */
export const lesson = new LessonPlayer()
export const subscribeLesson = (listener: () => void): (() => void) => lesson.subscribe(listener)
export const getLessonSnapshot = (): LessonSnapshot => lesson.getSnapshot()
