/**
 * Where a horizontal line's caption goes when several lines sit close together.
 *
 * Left alone, every hline draws its label at the same x, so ten levels inside a
 * narrow band produce a pile of overlapping text that reads as nothing. The
 * placement pass is the only code that sees all the lines at once, which is why
 * it lives outside the per-overlay renderer — and why it is worth pinning.
 */
import { describe, expect, it } from 'vitest'
import { assignLabelLanes } from '../src/client/ChartCard.js'

describe('assignLabelLanes', () => {
  it('keeps well-separated lines in the first lane', () => {
    // Nothing collides, so nothing needs to step sideways.
    expect(assignLabelLanes([100, 150, 200], 100, 200)).toEqual([0, 0, 0])
  })

  it('steps a colliding label into the next lane rather than over its neighbour', () => {
    // Two levels a tenth of a percent apart in a 100-wide window.
    const lanes = assignLabelLanes([150, 150.1], 100, 200)
    expect(new Set(lanes).size).toBe(2)
    expect(lanes).not.toContain(-1)
  })

  it('drops the caption once the lanes are full, keeping the line', () => {
    // Five levels stacked inside a hair's width: three can be captioned, the
    // rest draw unlabelled. -1 is "line without caption", never "no line".
    const lanes = assignLabelLanes([150, 150.05, 150.1, 150.15, 150.2], 100, 200)
    expect(lanes.filter(l => l >= 0)).toHaveLength(3)
    expect(lanes.filter(l => l === -1)).toHaveLength(2)
  })

  it('returns one lane per input, aligned by index', () => {
    const prices = [180, 120, 179.9, 121]
    expect(assignLabelLanes(prices, 100, 200)).toHaveLength(prices.length)
  })

  it('fills lanes down the axis, so reading order matches the eye', () => {
    // Placement runs highest price first, so the topmost line owns lane 0 and
    // the one just under it steps aside — not the other way round.
    const lanes = assignLabelLanes([120, 190, 190.1], 100, 200)
    expect(lanes[2]).toBe(0)   // 190.1 — the highest
    expect(lanes[1]).toBe(1)   // 190 — collides, steps out
    expect(lanes[0]).toBe(0)   // 120 — far below, lane 0 is free again
  })

  it('reuses a lane once the price has moved far enough down it', () => {
    // Lane 0 takes 200, lane 1 takes 199.9; by 150 lane 0 is free again.
    expect(assignLabelLanes([200, 199.9, 150], 100, 200)).toEqual([0, 1, 0])
  })

  it('labels everything when the window has no range to divide', () => {
    // A degenerate window must not silently hide every caption.
    expect(assignLabelLanes([100, 100], 100, 100)).toEqual([0, 0])
    expect(assignLabelLanes([100], NaN, NaN)).toEqual([0])
  })

  it('handles an empty set', () => {
    expect(assignLabelLanes([], 100, 200)).toEqual([])
  })
})
