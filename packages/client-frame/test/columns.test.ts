/**
 * The concession chain is the only real logic in the frame — everything else
 * is slot plumbing the host exercises. These cases pin the order in which
 * columns give way, because getting it wrong is invisible at desk widths and
 * only shows up on a laptop screen.
 */
import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN,
  CHART_MIN,
  CHART_RATIO_DEFAULT,
  CHART_RATIO_MAX,
  CHART_RATIO_MIN,
  clampRatio,
  clampWidth,
  computeColumns,
  DETAILS_DEFAULT,
  DETAILS_MIN,
  SIDEBAR_COLLAPSED,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from '../src/client/columns.js'

describe('clampWidth', () => {
  it('rounds and clamps into the range', () => {
    expect(clampWidth(300.4, 264, 420)).toBe(300)
    expect(clampWidth(10, 264, 420)).toBe(264)
    expect(clampWidth(9999, 264, 420)).toBe(420)
  })
})

describe('clampRatio', () => {
  it('clamps into the drag range', () => {
    expect(clampRatio(0.01)).toBe(CHART_RATIO_MIN)
    expect(clampRatio(0.99)).toBe(CHART_RATIO_MAX)
    expect(clampRatio(0.5)).toBe(0.5)
  })

  it('falls back to the default for a non-finite ratio', () => {
    expect(clampRatio(NaN)).toBe(CHART_RATIO_DEFAULT)
  })
})

describe('computeColumns', () => {
  const RAIL = SIDEBAR_COLLAPSED

  it('splits the free width 70/30 at a desk width', () => {
    const viewport = 1700
    const cols = computeColumns(viewport, 0, CHART_RATIO_DEFAULT, 0)
    const room = viewport - RAIL
    expect(cols.chart).toBe(Math.round(room * 0.7))
    expect(cols.center).toBe(room - cols.chart)
    // The ask, stated as the ask: seven tenths to the chart.
    expect(cols.chart / room).toBeCloseTo(0.7, 2)
  })

  it('keeps the same split at a different window size', () => {
    const a = computeColumns(1440, 0, CHART_RATIO_DEFAULT, 0)
    const b = computeColumns(2200, 0, CHART_RATIO_DEFAULT, 0)
    expect(a.chart / (a.chart + a.center)).toBeCloseTo(b.chart / (b.chart + b.center), 2)
  })

  it('never overlaps or overflows the viewport', () => {
    for (let viewport = 320; viewport <= 2600; viewport += 17) {
      const cols = computeColumns(viewport, SIDEBAR_DEFAULT, CHART_RATIO_DEFAULT, DETAILS_DEFAULT)
      const total = cols.sidebar + cols.chart + cols.center + cols.details
      expect(total).toBeLessThanOrEqual(Math.max(viewport, SIDEBAR_DEFAULT))
    }
  })

  it('holds the conversation floor before honouring the ratio', () => {
    const viewport = 1000
    const cols = computeColumns(viewport, 0, CHART_RATIO_MAX, 0)
    expect(cols.center).toBeGreaterThanOrEqual(CENTER_MIN)
  })

  it('shrinks details first, keeping the chart at its share', () => {
    const viewport = 1600
    const wide = computeColumns(viewport, 0, CHART_RATIO_DEFAULT, 0)
    const withDetails = computeColumns(viewport, 0, CHART_RATIO_DEFAULT, DETAILS_DEFAULT)
    expect(withDetails.details).toBeGreaterThan(0)
    expect(withDetails.chart).toBeLessThan(wide.chart)
    expect(withDetails.center).toBeGreaterThanOrEqual(CENTER_MIN)
  })

  it('closes details rather than starving both flexible columns', () => {
    const viewport = RAIL + CHART_MIN + CENTER_MIN + 10
    const cols = computeColumns(viewport, 0, CHART_RATIO_DEFAULT, DETAILS_DEFAULT)
    expect(cols.details).toBe(0)
    expect(cols.chart).toBeGreaterThanOrEqual(CHART_MIN)
  })

  it('closes the chart rather than rendering it below its floor', () => {
    const viewport = RAIL + CHART_MIN + CENTER_MIN - 1
    const cols = computeColumns(viewport, 0, CHART_RATIO_DEFAULT, 0)
    expect(cols.chart).toBe(0)
    expect(cols.center).toBe(viewport - RAIL)
  })

  it('gives the conversation everything when the chart is closed', () => {
    const cols = computeColumns(1700, 0, 0, 0)
    expect(cols.chart).toBe(0)
    expect(cols.center).toBe(1700 - RAIL)
  })

  it('never lets the sidebar concede', () => {
    for (const viewport of [900, 1280, 1920]) {
      const cols = computeColumns(viewport, SIDEBAR_DEFAULT, CHART_RATIO_DEFAULT, DETAILS_DEFAULT)
      expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    }
  })

  it('renders the collapsed rail for a closed sidebar', () => {
    expect(computeColumns(1600, 0, CHART_RATIO_DEFAULT, 0).sidebar).toBe(SIDEBAR_COLLAPSED)
  })

  it('re-clamps a stale sidebar preference crossing the store boundary', () => {
    expect(computeColumns(3000, SIDEBAR_MAX + 500, CHART_RATIO_DEFAULT, 0).sidebar).toBe(SIDEBAR_MAX)
    expect(computeColumns(3000, SIDEBAR_MIN - 100, CHART_RATIO_DEFAULT, 0).sidebar).toBe(SIDEBAR_MIN)
  })

  it('is pure — recovery on re-widening needs no hysteresis', () => {
    const before = computeColumns(1600, 0, CHART_RATIO_DEFAULT, DETAILS_DEFAULT)
    computeColumns(700, 0, CHART_RATIO_DEFAULT, DETAILS_DEFAULT)
    const after = computeColumns(1600, 0, CHART_RATIO_DEFAULT, DETAILS_DEFAULT)
    expect(after).toEqual(before)
  })
})
