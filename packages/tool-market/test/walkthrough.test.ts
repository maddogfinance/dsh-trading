import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { apply } from '../src/index.js'
import { resolveWalkthrough, roundPrice } from '../src/walkthrough.js'
import type { WalkthroughArgs, WalkthroughPayload } from '../src/walkthrough.js'

const DAY = 86_400_000

/**
 * Weekday daily bars opening 13:30 UTC, like a US listing, ending 2026-11-02.
 * The last few sessions replay the AAPL double top the walkthrough was
 * designed on, so the checks below are the real claims it got wrong.
 */
function dailyBars(): Candle[] {
  const out: Candle[] = []
  let t = Date.UTC(2026, 3, 1, 13, 30)
  let i = 0
  while (t <= Date.UTC(2026, 10, 2, 13, 30)) {
    const dow = new Date(t).getUTCDay()
    if (dow !== 0 && dow !== 6) {
      // Lows stay within 329–337 and highs under 344, so the planted bars below are the extremes.
      const base = 336 + Math.sin(i / 6) * 4
      out.push({ time: new Date(t).toISOString(), open: base, high: base + 3, low: base - 3, close: base + 1, volume: 40e6 + (i % 7) * 1e6 })
      i += 1
    }
    t += DAY
  }
  const set = (date: string, bar: Partial<Candle>): void => {
    const c = out.find(x => x.time.startsWith(date))
    if (c === undefined) throw new Error(`no bar on ${date}`)
    Object.assign(c, bar)
  }
  set('2026-09-29', { low: 328.7 })
  set('2026-10-01', { low: 325.81 })
  set('2026-10-23', { high: 351.7300109863281, low: 345.75 })
  set('2026-10-26', { low: 341.03 })
  set('2026-10-29', { high: 351.43 })
  set('2026-10-30', { low: 334.35, close: 344.63, volume: 67.8e6 })
  set('2026-11-02', { low: 335.82, close: 338.32, volume: 63.8e6 })
  return out
}

const BARS = dailyBars()

function section(over: Partial<WalkthroughArgs>): WalkthroughArgs {
  return { symbol: 'AAPL', timeframe: '1d', section: '双顶', from: '2026-10-06', lines: [{ say: '先看这里。' }], ...over }
}

describe('resolveWalkthrough: anchors', () => {
  it('reads a circled value off the bar, rounded the way a reader quotes it', () => {
    const { payload, summary } = resolveWalkthrough(section({
      marks: [{ id: 'p1', type: 'circle', at: { time: '2026-10-23', field: 'high' } }],
      lines: [{ say: '[[p1|10/23]] 冲到 351.73，没站住。', draw: ['p1'], point: 'p1' }],
    }), BARS, 'test')
    const mark = payload.marks[0]!
    expect(mark.at).toEqual({ t: Date.parse('2026-10-23T13:30:00.000Z'), v: 351.73 })
    expect(mark.surface).toBe('price')
    expect(summary).toContain('p1 = high 2026-10-23 351.73')
  })

  it('refuses a quoted value the bar never printed, and says which bar did', () => {
    // The live session wrote "Oct 23 low 341.03": a 4h label that straddled sessions.
    expect(() => resolveWalkthrough(section({
      marks: [{ id: 'tr', type: 'circle', at: { time: '2026-10-23', field: 'low', value: 341.03 } }],
      lines: [{ say: '回落到 341.03。', draw: ['tr'] }],
    }), BARS, 'test')).toThrow(/low of 2026-10-23 is 345\.75, not 341\.03 \(341\.03 is the low of 2026-10-26\)/)
  })

  it('accepts a quoted value within reading precision', () => {
    expect(() => resolveWalkthrough(section({
      marks: [{ id: 'p1', type: 'circle', at: { time: '2026-10-23', field: 'high', value: 351.73 } }],
      lines: [{ say: '351.73。', draw: ['p1'] }],
    }), BARS, 'test')).not.toThrow()
  })

  it('lands a weekend date on the session before it', () => {
    const { payload } = resolveWalkthrough(section({
      marks: [{ id: 'c', type: 'circle', at: { time: '2026-10-25', field: 'close' } }],
      lines: [{ say: '周五收盘。', draw: ['c'] }],
    }), BARS, 'test')
    expect(new Date(payload.marks[0]!.at!.t).toISOString().slice(0, 10)).toBe('2026-10-23')
  })

  it('rejects times outside the bars it fetched', () => {
    expect(() => resolveWalkthrough(section({
      marks: [{ id: 'c', type: 'circle', at: { time: '2026-12-01', field: 'close' } }],
      lines: [{ say: 'x', draw: ['c'] }],
    }), BARS, 'test')).toThrow(/after the last bar/)
  })
})

describe('resolveWalkthrough: level sources', () => {
  it('checks a "lowest since" claim and names the real extreme', () => {
    // The live session called 328.70 (9/29) the range floor; 10/1 printed 325.81.
    expect(() => resolveWalkthrough(section({
      marks: [{ id: 'floor', type: 'level', price: 328.7, source: { field: 'low', stat: 'min', from: '2026-09-11' } }],
      lines: [{ say: '下沿 328.70。', draw: ['floor'] }],
    }), BARS, 'test')).toThrow(/lowest low over 2026-09-11 → 2026-11-02 is 325\.81 \(2026-10-01\), not 328\.7/)
    const ok = resolveWalkthrough(section({
      marks: [{ id: 'floor', type: 'level', price: 325.81, source: { field: 'low', stat: 'min', from: '2026-09-11' } }],
      lines: [{ say: '下沿 325.81。', draw: ['floor'] }],
    }), BARS, 'test')
    expect(ok.payload.marks[0]!.price).toBe(325.81)
    expect(ok.summary).toContain('min low 2026-09-11 → 2026-11-02 (2026-10-01)')
  })

  it('checks a level read on one bar', () => {
    expect(() => resolveWalkthrough(section({
      marks: [{ id: 'neck', type: 'level', price: 341.03, source: { field: 'low', time: '2026-10-23' } }],
      lines: [{ say: '颈线。', draw: ['neck'] }],
    }), BARS, 'test')).toThrow(/341\.03 is the low of 2026-10-26/)
  })

  it('wants a source or a reason for every level', () => {
    expect(() => resolveWalkthrough(section({
      marks: [{ id: 'l', type: 'level', price: 340 }],
      lines: [{ say: 'x', draw: ['l'] }],
    }), BARS, 'test')).toThrow(/say where 340 comes from/)
    expect(() => resolveWalkthrough(section({
      marks: [{ id: 'l', type: 'level', price: 340, why: '整数关口' }],
      lines: [{ say: 'x', draw: ['l'] }],
    }), BARS, 'test')).not.toThrow()
  })

  it('gates a level to the plausible range of the bars', () => {
    expect(() => resolveWalkthrough(section({
      marks: [{ id: 'l', type: 'level', price: 900, why: 'x' }],
      lines: [{ say: 'x', draw: ['l'] }],
    }), BARS, 'test')).toThrow(/outside the plausible range/)
  })
})

describe('resolveWalkthrough: panes, paths and lines', () => {
  it('opens the pane an indicator field lives on and ships its columns over the window', () => {
    const { payload } = resolveWalkthrough(section({
      marks: [{ id: 'k', type: 'circle', at: { time: '2026-11-02', field: 'stoch_k' } }],
      lines: [{ say: '随机指标。', draw: ['k'] }],
    }), BARS, 'test')
    expect(payload.pane).toBe('stoch')
    expect(payload.marks[0]!.surface).toBe('indicator')
    expect(Object.keys(payload.series!.cols)).toEqual(['stoch_k', 'stoch_d'])
    expect(payload.series!.t[0]).toBe(payload.window.from)
    expect(payload.series!.cols['stoch_k']!.length).toBe(payload.series!.t.length)
  })

  it('keeps one indicator pane per section', () => {
    expect(() => resolveWalkthrough(section({
      pane: 'macd',
      marks: [{ id: 'k', type: 'circle', at: { time: '2026-11-02', field: 'rsi14' } }],
      lines: [{ say: 'x', draw: ['k'] }],
    }), BARS, 'test')).toThrow(/one indicator pane per section/)
  })

  it('puts volume marks on the volume pane and resolves spotlit bars', () => {
    const { payload } = resolveWalkthrough(section({
      marks: [{ id: 'v1', type: 'circle', at: { time: '2026-10-30', field: 'volume' } }],
      lines: [{ say: '放量。', draw: ['v1'], volume: ['2026-10-30', '2026-11-02'] }],
    }), BARS, 'test')
    expect(payload.marks[0]!.surface).toBe('volume')
    expect(payload.marks[0]!.at!.v).toBe(67.8e6)
    expect(payload.lines[0]!.volume).toEqual([Date.parse('2026-10-30T13:30:00.000Z'), Date.parse('2026-11-02T13:30:00.000Z')])
  })

  it('projects a path past the last bar only after its bar points', () => {
    const { payload } = resolveWalkthrough(section({
      marks: [{ id: 'up', type: 'arrow', tone: 'up', points: [{ time: '2026-11-02', field: 'close' }, { ahead: 4, price: 342.7 }, { ahead: 10, price: 348 }] }],
      lines: [{ say: '站回 342.36 就偏多。', draw: ['up'] }],
    }), BARS, 'test')
    expect(payload.marks[0]!.points).toEqual([{ t: Date.parse('2026-11-02T13:30:00.000Z'), v: 338.32 }, { ahead: 4, v: 342.7 }, { ahead: 10, v: 348 }])
    expect(() => resolveWalkthrough(section({
      marks: [{ id: 'bad', type: 'path', points: [{ ahead: 2, price: 340 }, { time: '2026-11-02', field: 'close' }] }],
      lines: [{ say: 'x', draw: ['bad'] }],
    }), BARS, 'test')).toThrow(/bar points come before projections/)
  })

  it('only draws marks the section defines, and draws every one of them', () => {
    expect(() => resolveWalkthrough(section({
      lines: [{ say: 'x', draw: ['ghost'] }],
    }), BARS, 'test')).toThrow(/draws 'ghost'/)
    expect(() => resolveWalkthrough(section({
      marks: [{ id: 'z', type: 'zone', low: 334.35, high: 337, why: '两个低点和布林下轨' }],
      lines: [{ say: 'x' }],
    }), BARS, 'test')).toThrow(/mark 'z' is never drawn/)
  })

  it('lets a line point at or re-light marks of earlier sections', () => {
    const { payload } = resolveWalkthrough(section({
      lines: [{ say: '回到我们一开始说的[[zone|那一段]]。', focus: 'zone', point: 'zone' }],
    }), BARS, 'test')
    expect(payload.lines[0]).toEqual({ say: '回到我们一开始说的[[zone|那一段]]。', point: 'zone', focus: 'zone' })
  })

  it('frames the last 60 bars by default and refuses a window of a few bars', () => {
    const { payload } = resolveWalkthrough({ symbol: 'AAPL', timeframe: '1d', section: 's', lines: [{ say: 'x' }] }, BARS, 'test')
    expect(payload.window.to).toBe(Date.parse(BARS.at(-1)!.time))
    expect(payload.window.from).toBe(Date.parse(BARS.at(-60)!.time))
    expect(() => resolveWalkthrough(section({ from: '2026-10-30' }), BARS, 'test')).toThrow(/fewer than 5 bars/)
  })

  it('cleans what it will render and caps replies', () => {
    const { payload, summary } = resolveWalkthrough(section({
      section: '结\u0000论',
      lines: [{ say: 'a\u0007b' }],
      ask: ['好，你说', '先告诉我盯哪两个价'],
    }), BARS, 'test')
    expect(payload.section).toBe('结 论')
    expect(payload.lines[0]!.say).toBe('a b')
    expect(payload.ask).toEqual(['好，你说', '先告诉我盯哪两个价'])
    expect(summary).toContain('End your turn now')
    expect(() => resolveWalkthrough(section({ ask: ['a', 'b', 'c', 'd'] }), BARS, 'test')).toThrow(/at most 3/)
  })

  it('resolves intraday times to the bar that contains them', () => {
    const hourly: Candle[] = Array.from({ length: 80 }, (_, i) => ({
      time: new Date(Date.UTC(2026, 9, 1) + i * 3_600_000 * 4).toISOString(),
      open: 100, high: 101 + (i === 70 ? 5 : 0), low: 99, close: 100.5, volume: 10,
    }))
    const { payload } = resolveWalkthrough({
      symbol: 'BTC-USD', timeframe: '4h', section: 's', from: hourly[40]!.time,
      marks: [{ id: 'h', type: 'circle', at: { time: new Date(Date.parse(hourly[70]!.time) + 3_600_000).toISOString(), field: 'high', value: 106 } }],
      lines: [{ say: 'x', draw: ['h'] }],
    }, hourly, 'test')
    expect(payload.marks[0]!.at).toEqual({ t: Date.parse(hourly[70]!.time), v: 106 })
  })
})

describe('resolveWalkthrough: annotate_chart habits', () => {
  it('reads role as tone, so a carried-over role is not a wasted call', () => {
    const { payload } = resolveWalkthrough(section({
      marks: [
        { id: 's', type: 'level', price: 334.35, role: 'support', why: '10/30 低点' },
        { id: 'r', type: 'level', price: 351.73, role: 'resistance', why: '双顶' },
        { id: 'n', type: 'level', price: 341.03, role: 'neckline', tone: 'down', why: '颈线' },
      ],
      lines: [{ say: 'x', draw: ['s', 'r', 'n'] }],
    }), BARS, 'test')
    expect(payload.marks.map(m => m.tone)).toEqual(['up', 'down', 'down'])
  })
})

describe('roundPrice', () => {
  it('quotes cents above 1 and five significant digits below', () => {
    expect(roundPrice(351.7300109863281)).toBe(351.73)
    expect(roundPrice(0.000123456)).toBe(0.00012346)
  })
})

describe('walkthrough tool wiring', () => {
  it('renders the summary to the model and hands the resolved section to the card', async () => {
    const tools = new Map<string, { name: string; execute: (a: unknown, e: unknown) => Promise<unknown>; output: { render: (a: unknown, v: never) => { text?: string }[]; presentationMeta?: (a: unknown, v: never) => unknown } }>()
    const provider = { id: 'test', description: 'fixture', listSymbols: async () => [], getOhlcv: async () => BARS }
    apply({ tools: { register: (d: never) => { tools.set((d as { name: string }).name, d) } }, marketData: { provider: () => provider } } as never, { chartDir: './charts' })
    const tool = tools.get('walkthrough')!
    const value = await tool.execute(section({
      marks: [{ id: 'p1', type: 'circle', at: { time: '2026-10-23', field: 'high' } }],
      lines: [{ say: '冲到 351.73。', draw: ['p1'] }],
    }), {}) as never
    expect(tool.output.render({}, value)[0]!.text).toContain('Read off the bars')
    const meta = tool.output.presentationMeta!({}, value) as WalkthroughPayload
    expect(meta.kind).toBe('walkthrough')
    expect(meta.version).toBe(1)
    expect(meta.close).toBe(338.32)
    expect(JSON.stringify(meta)).toBe(JSON.stringify(JSON.parse(JSON.stringify(meta))))
  })
})
