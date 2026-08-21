/**
 * The lift seam between the chat card and the frame's persistent column.
 * Small surface, but two properties matter and neither is obvious from
 * reading the three functions: publishing the SAME payload must not wake
 * subscribers (cards re-render constantly), and the snapshot reference must be
 * stable between publishes or `useSyncExternalStore` will loop forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getLatestChart, publishLatestChart, subscribeLatestChart } from '../src/client/latest.js'
import { annotationDigest } from '../src/client/payload.js'
import type { ChartPayload } from '../src/client/payload.js'

function payload(symbol: string): ChartPayload {
  return { symbol, provider: 'test', timeframes: [] } as unknown as ChartPayload
}

describe('latest chart store', () => {
  beforeEach(() => {
    // The store is module state; park a known value so cases do not leak.
    publishLatestChart(payload('__reset__'))
  })

  it('hands the newest payload to readers', () => {
    const a = payload('AAA')
    publishLatestChart(a)
    expect(getLatestChart()).toBe(a)
  })

  it('returns a stable reference between publishes', () => {
    publishLatestChart(payload('AAA'))
    expect(getLatestChart()).toBe(getLatestChart())
  })

  it('notifies subscribers on change', () => {
    const listener = vi.fn()
    const off = subscribeLatestChart(listener)
    publishLatestChart(payload('BBB'))
    expect(listener).toHaveBeenCalledTimes(1)
    off()
  })

  it('stays quiet when the same payload is republished', () => {
    const same = payload('CCC')
    publishLatestChart(same)
    const listener = vi.fn()
    const off = subscribeLatestChart(listener)
    publishLatestChart(same)
    publishLatestChart(same)
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const off = subscribeLatestChart(listener)
    off()
    publishLatestChart(payload('DDD'))
    expect(listener).not.toHaveBeenCalled()
  })

  it('serves every live subscriber', () => {
    const one = vi.fn()
    const two = vi.fn()
    const offOne = subscribeLatestChart(one)
    const offTwo = subscribeLatestChart(two)
    publishLatestChart(payload('EEE'))
    expect(one).toHaveBeenCalledTimes(1)
    expect(two).toHaveBeenCalledTimes(1)
    offOne()
    offTwo()
  })

  it('lets the newest publish win', () => {
    const first = payload('FFF')
    const second = payload('GGG')
    publishLatestChart(first)
    publishLatestChart(second)
    expect(getLatestChart()).toBe(second)
  })
})

describe('seriesKey identity (regression)', () => {
  it('distinguishes two windows of the same instrument carrying the same marks', () => {
    // The panel swaps the agent's short window for the user's long one while
    // the marks ride along. Keyed on marks alone the two are byte-identical,
    // so the chart never re-inits and keeps the old candles under the new
    // caption. The left edge is what tells them apart — and a live tail can
    // never change it, because mergeTail only replaces or appends at the end.
    const marks = annotationDigest([{ type: 'level', price: 100 }] as never, [])
    const short = `futu|US.MU|1d|2026-08-01T00:00:00.000Z|${marks}`
    const long = `futu|US.MU|1d|2024-08-01T00:00:00.000Z|${marks}`
    expect(short).not.toBe(long)
  })
})

describe('annotationDigest', () => {
  it('differs when the same annotation types carry different prices', () => {
    // The exact collision the old type-list key had: three levels replaced by
    // three different levels produced a byte-identical key, so the canvas kept
    // the old prices while the table printed the new ones.
    const a = [{ type: 'level', price: 100 }] as never
    const b = [{ type: 'level', price: 101 }] as never
    expect(annotationDigest(a, [])).not.toBe(annotationDigest(b, []))
  })

  it('differs when the same scenario count carries different trigger prices', () => {
    const s = (p: number) => [{
      direction: 'bull' as const, stance: 'base' as const,
      thesis: 't', trigger: 'x', invalidation: 'y', triggerPrice: p,
    }]
    expect(annotationDigest([], s(10))).not.toBe(annotationDigest([], s(11)))
  })

  it('is stable for equal content', () => {
    expect(annotationDigest([], [])).toBe(annotationDigest(undefined, undefined))
  })
})
