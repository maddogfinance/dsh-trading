/**
 * When the chart column chases the conversation, and when it must not.
 *
 * Every case here corresponds to something that actually went wrong on screen:
 * a column showing a frozen snapshot because it never fetched for itself, a
 * chart yanked out from under someone mid-read, and a refetch storm from an
 * analysis that re-charts the same instrument dozens of times in one turn.
 */
import { describe, expect, it } from 'vitest'
import { decideFollow } from '../src/client/follow.js'
import type { FollowState } from '../src/client/follow.js'

const OPEN: FollowState = { width: 800, pinned: false, own: null }
const target = { symbol: 'CC.BTCUSDT', timeframe: '15m' }

describe('decideFollow', () => {
  it('loads the conversation\'s chart as the column\'s own live series', () => {
    // The agent's payload is a frozen <=200-bar snapshot and the live loop only
    // runs on a series the panel fetched itself — adopting it verbatim gives a
    // chart that never moves, which is exactly what users reported.
    expect(decideFollow(target, OPEN)).toEqual({ action: 'load', symbol: 'CC.BTCUSDT', timeframe: '15m' })
  })

  it('does nothing when there is nothing to follow', () => {
    expect(decideFollow(null, OPEN)).toEqual({ action: 'none' })
  })

  it('does not fetch for a closed column', () => {
    // The frame keeps the subtree mounted at width 0; a fetch there would buy
    // bars nobody can see.
    expect(decideFollow(target, { ...OPEN, width: 0 })).toEqual({ action: 'none' })
  })

  it('ignores a target with no usable symbol or timeframe', () => {
    expect(decideFollow({ symbol: '   ', timeframe: '15m' }, OPEN)).toEqual({ action: 'none' })
    expect(decideFollow({ symbol: 'CC.BTCUSDT', timeframe: undefined }, OPEN)).toEqual({ action: 'none' })
  })

  it('refuses to refetch the series already on screen', () => {
    // One analysis calls annotate_chart dozens of times on the same chart.
    // Reloading each time would discard the live series and the user's scroll
    // position for bars the column already holds.
    const state = { ...OPEN, own: { symbol: 'CC.BTCUSDT', timeframe: '15m' } }
    expect(decideFollow(target, state)).toEqual({ action: 'already' })
  })

  it('treats case and surrounding space as the same instrument', () => {
    const state = { ...OPEN, own: { symbol: ' cc.btcusdt ', timeframe: '15m' } }
    expect(decideFollow(target, state)).toEqual({ action: 'already' })
  })

  it('follows when only the timeframe moved', () => {
    const state = { ...OPEN, own: { symbol: 'CC.BTCUSDT', timeframe: '1h' } }
    expect(decideFollow(target, state)).toEqual({ action: 'load', symbol: 'CC.BTCUSDT', timeframe: '15m' })
  })

  it('holds instead of taking the chart from a user who is driving', () => {
    // Pinned means the column belongs to the user; the agent's chart becomes an
    // offer on the pill rather than a takeover mid-read.
    const state = { ...OPEN, pinned: true, own: { symbol: 'US.MU', timeframe: '1d' } }
    expect(decideFollow(target, state)).toEqual({ action: 'hold' })
  })

  it('reports "already", not "hold", when a pinned column is on that very series', () => {
    // Otherwise the pill would offer the user a chart they are already reading.
    const state = { ...OPEN, pinned: true, own: { symbol: 'CC.BTCUSDT', timeframe: '15m' } }
    expect(decideFollow(target, state)).toEqual({ action: 'already' })
  })

  it('follows a pinned-then-unpinned column again', () => {
    const pinnedState = { ...OPEN, pinned: true, own: { symbol: 'US.MU', timeframe: '1d' } }
    expect(decideFollow(target, pinnedState).action).toBe('hold')
    expect(decideFollow(target, { ...pinnedState, pinned: false }).action).toBe('load')
  })

  it('never fetches from a closed column even when the user has pinned it', () => {
    const state = { width: 0, pinned: true, own: { symbol: 'US.MU', timeframe: '1d' } }
    expect(decideFollow(target, state)).toEqual({ action: 'none' })
  })
})
