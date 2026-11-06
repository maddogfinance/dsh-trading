/**
 * The walkthrough on the client: reading the section a tool wrote, speaking
 * it in time, and knowing what the chart shows at every line.
 *
 * The player cases are the behaviours that make it a conversation rather than
 * a report: lines arrive one at a time, sections queue behind each other,
 * history never replays at you, and a click on an earlier line takes the
 * chart back to that moment without losing your place.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { arrowHead, loop, polyline, rng, seedOf } from '../src/client/ink.js'
import { boardAt, LessonPlayer } from '../src/client/lesson.js'
import type { LessonSection } from '../src/client/lesson.js'
import { withLessonSeries } from '../src/client/market-client.js'
import type { ChartPayload } from '../src/client/payload.js'
import { parseSay, plainSay, readWalkthrough } from '../src/client/walkthrough.js'
import type { Walkthrough } from '../src/client/walkthrough.js'

const T = (d: string): number => Date.parse(`${d}T13:30:00.000Z`)

function section(over: Partial<Walkthrough> = {}): Walkthrough {
  return {
    provider: 'public', symbol: 'AAPL', timeframe: '1d', section: '双顶',
    window: { from: T('2026-10-06'), to: T('2026-11-02') },
    marks: [
      { id: 'p1', type: 'circle', surface: 'price', tone: 'neutral', at: { t: T('2026-10-23'), v: 351.73 } },
      { id: 'neck', type: 'level', surface: 'price', tone: 'neutral', price: 341.03, label: '颈线 341.03' },
    ],
    lines: [
      { say: '先看这里。' },
      { say: '[[p1|10/23]] 冲到 351.73，没站住。', draw: ['p1'], point: 'p1' },
      { say: '中间这个 341.03 叫颈线。', draw: ['neck'], point: 'neck' },
    ],
    close: 338.32,
    ...over,
  }
}

describe('readWalkthrough', () => {
  it('reads what the tool wrote and drops what it cannot draw', () => {
    const meta = JSON.parse(JSON.stringify({ kind: 'walkthrough', version: 1, ...section() }))
    meta.marks.push({ id: 'bad', type: 'circle', at: { v: 1 } }, { id: 'x', type: 'teleport' })
    const w = readWalkthrough(meta)
    expect(w).not.toBeNull()
    expect(w!.marks.map(m => m.id)).toEqual(['p1', 'neck'])
    expect(w!.lines).toHaveLength(3)
  })

  it('refuses foreign or empty payloads', () => {
    expect(readWalkthrough({ kind: 'chart', version: 1 })).toBeNull()
    expect(readWalkthrough({ kind: 'walkthrough', version: 2, ...section() })).toBeNull()
    expect(readWalkthrough({ kind: 'walkthrough', version: 1, ...section({ lines: [] }) })).toBeNull()
  })
})

describe('parseSay', () => {
  it('ties words to marks and keeps everything else literal', () => {
    expect(parseSay('回到[[zone|那一段]]，**偏多**。')).toEqual([
      { text: '回到' }, { text: '那一段', mark: 'zone' }, { text: '，' }, { text: '偏多', bold: true }, { text: '。' },
    ])
    expect(parseSay('<img src=x onerror=alert(1)> [[bad id|x]]')).toEqual([{ text: '<img src=x onerror=alert(1)> [[bad id|x]]' }])
    expect(plainSay('[[p1|10/23]] 冲到 351.73')).toBe('10/23 冲到 351.73')
  })
})

describe('boardAt', () => {
  const sections = (...list: LessonSection[]): Map<string, LessonSection> => new Map(list.map(s => [s.callId, s]))

  it('draws what has been said so far, and only the newest line animates', () => {
    const s = { callId: 'a', time: 1, data: section() }
    const b1 = boardAt(sections(s), { callId: 'a', line: 1 }, null)!
    expect(b1.marks.map(m => [m.id, m.fresh])).toEqual([['p1', true]])
    expect(b1.pointer).toEqual({ mark: 'p1' })
    const b2 = boardAt(sections(s), { callId: 'a', line: 2 }, null)!
    expect(b2.marks.map(m => [m.id, m.fresh])).toEqual([['p1', false], ['neck', true]])
    expect(b2.beat).not.toBe(b1.beat)
  })

  it('lets the pointer rest on the last thing named', () => {
    const s = { callId: 'a', time: 1, data: section({ lines: [...section().lines, { say: '所以说。' }] }) }
    expect(boardAt(sections(s), { callId: 'a', line: 3 }, null)!.pointer).toEqual({ mark: 'neck' })
  })

  it('keeps the conclusion\'s zone faintly through later sections, and re-lights it on focus', () => {
    const conclusion = {
      callId: 'c', time: 1, data: section({
        section: '结论',
        marks: [{ id: 'zone', type: 'zone', surface: 'price', tone: 'neutral', low: 334.35, high: 337, keep: true }],
        lines: [{ say: '334 到 337 决定方向。', draw: ['zone'], point: 'zone' }],
      }),
    }
    const later = { callId: 'd', time: 2, data: section({ lines: [{ say: '先看这里。' }, { say: '回到[[zone|那一段]]。', focus: 'zone', point: 'zone' }] }) }
    const all = sections(conclusion, later)
    expect(boardAt(all, { callId: 'd', line: 0 }, null)!.marks).toEqual([expect.objectContaining({ id: 'zone', state: 'faint' })])
    const lit = boardAt(all, { callId: 'd', line: 1 }, null)!
    expect(lit.marks).toEqual([expect.objectContaining({ id: 'zone', state: 'on', flash: true })])
    expect(lit.pointer).toEqual({ mark: 'zone' })
  })

  it('does not carry marks across instruments or onto a weekly overview', () => {
    const conclusion = { callId: 'c', time: 1, data: section({ marks: [{ id: 'zone', type: 'zone', surface: 'price', tone: 'neutral', low: 1, high: 2, keep: true }], lines: [{ say: 'x', draw: ['zone'] }] }) }
    expect(boardAt(sections(conclusion, { callId: 'd', time: 2, data: section({ symbol: 'MSFT' }) }), { callId: 'd', line: 0 }, null)!.marks).toEqual([])
    expect(boardAt(sections(conclusion, { callId: 'w', time: 2, data: section({ timeframe: '1w' }) }), { callId: 'w', line: 0 }, null)!.marks).toEqual([])
  })

  it('leaves room past the last bar for projections and drops a far SMA200 on daily charts', () => {
    const arrow = section({
      marks: [{ id: 'up', type: 'arrow', surface: 'price', tone: 'up', points: [{ t: T('2026-11-02'), v: 338.32 }, { ahead: 10, v: 348 }] }],
      lines: [{ say: 'x', draw: ['up'] }],
    })
    const b = boardAt(sections({ callId: 'a', time: 1, data: arrow }), { callId: 'a', line: 0 }, null)!
    expect(b.frame.pad).toBeGreaterThan(150)
    expect(b.ma).toEqual([20, 50])
    expect(boardAt(sections({ callId: 'w', time: 1, data: section({ timeframe: '1w' }) }), { callId: 'w', line: 0 }, null)!.ma).toEqual([20, 50, 200])
  })
})

describe('LessonPlayer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('speaks a live section one line at a time, moving the cursor with each', () => {
    const p = new LessonPlayer()
    p.register('a', Date.now(), section(), true)
    expect(p.getSnapshot().shown.get('a')).toBe(0)
    vi.advanceTimersByTime(300)
    expect(p.getSnapshot().typing).toBe('a')
    vi.advanceTimersByTime(1000)
    expect(p.getSnapshot().shown.get('a')).toBe(1)
    expect(p.getSnapshot().cursor).toEqual({ callId: 'a', line: 0 })
    vi.advanceTimersByTime(30_000)
    expect(p.getSnapshot().shown.has('a')).toBe(false)
    expect(p.getSnapshot().cursor).toEqual({ callId: 'a', line: 2 })
    expect(p.getSnapshot().mode).toBe('idle')
  })

  it('shows history settled and puts the chart on its last line', () => {
    const p = new LessonPlayer()
    p.register('old', Date.now() - 600_000, section(), false)
    expect(p.getSnapshot().shown.has('old')).toBe(false)
    expect(p.getSnapshot().cursor).toEqual({ callId: 'old', line: 2 })
    expect(p.getSnapshot().mode).toBe('idle')
  })

  it('queues a section that lands while another is being spoken', () => {
    const p = new LessonPlayer()
    p.register('a', Date.now(), section(), true)
    vi.advanceTimersByTime(1500)
    p.register('b', Date.now(), section({ section: '放量' }), true)
    expect(p.getSnapshot().shown.get('b')).toBe(0)
    expect(p.getSnapshot().cursor?.callId).toBe('a')
    vi.advanceTimersByTime(60_000)
    expect(p.getSnapshot().cursor).toEqual({ callId: 'b', line: 2 })
  })

  it('says the next line at once when hurried', () => {
    const p = new LessonPlayer()
    p.register('a', Date.now(), section(), true)
    vi.advanceTimersByTime(300)
    p.hurry()
    expect(p.getSnapshot().shown.get('a')).toBe(1)
    p.hurry()
    p.hurry()
    expect(p.getSnapshot().shown.get('a')).toBe(2)
  })

  it('stops when the reader looks, and carries on from the same line', () => {
    const p = new LessonPlayer()
    p.register('a', Date.now(), section(), true)
    vi.advanceTimersByTime(1500)
    p.pause(true)
    expect(p.getSnapshot()).toEqual(expect.objectContaining({ mode: 'paused', look: true }))
    vi.advanceTimersByTime(60_000)
    expect(p.getSnapshot().shown.get('a')).toBe(1)
    p.resume()
    vi.advanceTimersByTime(60_000)
    expect(p.getSnapshot().mode).toBe('idle')
    expect(p.getSnapshot().cursor).toEqual({ callId: 'a', line: 2 })
  })

  it('replays an earlier line and returns to where it was', () => {
    const p = new LessonPlayer()
    p.register('a', Date.now(), section(), true)
    // Mid-section: the second line is on screen and the third is still to come.
    vi.advanceTimersByTime(2500)
    const here = p.getSnapshot().cursor
    expect(here).toEqual({ callId: 'a', line: 1 })
    p.replay('a', 0)
    expect(p.getSnapshot()).toEqual(expect.objectContaining({ mode: 'replay', cursor: { callId: 'a', line: 0 } }))
    p.backToLive()
    expect(p.getSnapshot().cursor).toEqual(here)
    expect(p.getSnapshot().mode).toBe('live')
  })

  it('offers replies only once everything is said, and stops once answered', () => {
    const p = new LessonPlayer()
    p.register('a', Date.now(), section({ ask: ['好，你说'] }), true)
    vi.advanceTimersByTime(1500)
    expect(p.getSnapshot().asking).toBeNull()
    p.skipAll()
    expect(p.getSnapshot().asking).toBe('a')
    p.answer('a')
    expect(p.getSnapshot().asking).toBeNull()
  })

  it('hands the chart back on dismiss', () => {
    const p = new LessonPlayer()
    p.register('a', Date.now(), section(), true)
    vi.advanceTimersByTime(1500)
    p.dismiss()
    expect(p.getSnapshot()).toEqual(expect.objectContaining({ mode: 'idle', cursor: null, board: null }))
    expect(p.getSnapshot().shown.has('a')).toBe(false)
  })
})

describe('ink', () => {
  it('draws the same wobble for the same mark every time', () => {
    const a = loop({ x: 10, y: 10 }, 12, 8, rng(seedOf('p1')))
    const b = loop({ x: 10, y: 10 }, 12, 8, rng(seedOf('p1')))
    expect(a).toBe(b)
    expect(a).not.toBe(loop({ x: 10, y: 10 }, 12, 8, rng(seedOf('p2'))))
    expect(polyline([{ x: 0, y: 0 }, { x: 50, y: 10 }, { x: 90, y: 0 }], rng(1), true).match(/M/g)).toHaveLength(4)
    expect(arrowHead({ x: 0, y: 0 }, { x: 40, y: 0 }, rng(2)).match(/M/g)).toHaveLength(2)
  })
})

describe('withLessonSeries', () => {
  it('lays the section\'s columns onto the column\'s bars by time, not by position', () => {
    const bars = ['2026-10-29', '2026-10-30', '2026-11-02'].map(d => ({ time: `${d}T13:30:00.000Z`, open: 1, high: 1, low: 1, close: 1, volume: 1 }))
    const payload: ChartPayload = { kind: 'chart', version: 1, provider: 'p', symbol: 'AAPL', timeframes: [{ timeframe: '1d', candles: bars, indicators: null }] }
    const out = withLessonSeries(payload, { t: [T('2026-10-30'), T('2026-11-02')], cols: { stoch_k: [20.5, 12.2] } })
    expect(out.timeframes[0]!.series).toEqual({ stoch_k: [null, 20.5, 12.2] })
    expect(withLessonSeries(payload, undefined)).toBe(payload)
  })
})
