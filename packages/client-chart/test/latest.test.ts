/**
 * The lift seam between the chat card and the frame's persistent column.
 * Small surface, but two properties matter and neither is obvious from
 * reading the three functions: publishing the SAME payload must not wake
 * subscribers (cards re-render constantly), and the snapshot reference must be
 * stable between publishes or `useSyncExternalStore` will loop forever.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getLatestChart, publishLatestChart, subscribeLatestChart } from '../src/client/latest.js'
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
