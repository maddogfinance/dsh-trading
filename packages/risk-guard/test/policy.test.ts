import { describe, expect, it } from 'vitest'
import { compilePolicy, DEFAULT_DENY_PATTERNS } from '../src/policy.js'

const defaults = { mode: 'denylist' as const, deny: DEFAULT_DENY_PATTERNS, allow: [] }
const guard = compilePolicy(defaults)

describe('denylist mode', () => {
  it.each([
    'place_order',
    'submit_order',
    'cancel_order',
    'execute_trade',
    'order_submit',
    'trades_cancel',
    'buy',
    'sell',
    'short',
    'buy_market',
    'sell_limit',
    'close_position',
    'liquidate_positions',
    'withdraw',
    'withdraw_funds',
    'transfer_balance',
    'swap_tokens',
  ])('refuses %s', (name) => {
    expect(guard(name).allowed).toBe(false)
  })

  it.each([
    'get_ohlcv',
    'list_symbols',
    'read_file',
    'bash',
    'web_search',
    'todo_write',
    'backtest_run',
    'order_book_depth',
    'trade_history',
    'position_report',
  ])('permits %s', (name) => {
    expect(guard(name).allowed).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(guard('PlaceOrder').allowed).toBe(true)
    expect(guard('Place_Order').allowed).toBe(false)
    expect(guard('SELL').allowed).toBe(false)
  })

  it('names the matched pattern and the escape hatch in the reason', () => {
    const verdict = guard('place_order')
    expect(verdict.allowed).toBe(false)
    if (verdict.allowed) return
    expect(verdict.reason).toContain('place_order')
    expect(verdict.reason).toContain('research-only')
    expect(verdict.reason).toContain('allow')
  })

  it('exempts an exact name on the allow list', () => {
    const lenient = compilePolicy({ ...defaults, allow: ['sell_signal_scan'] })
    expect(guard('sell_signal_scan').allowed).toBe(false)
    expect(lenient('sell_signal_scan').allowed).toBe(true)
    // The exemption is exact, not a prefix.
    expect(lenient('sell_signal_scan_v2').allowed).toBe(false)
  })

  it('accepts a custom pattern set, replacing the defaults', () => {
    const custom = compilePolicy({ ...defaults, deny: ['^broker_'] })
    expect(custom('broker_action').allowed).toBe(false)
    expect(custom('place_order').allowed).toBe(true)
  })

  it('rejects an invalid pattern at compile time, not at call time', () => {
    expect(() => compilePolicy({ ...defaults, deny: ['('] })).toThrow(/not a valid regular expression/)
  })
})

describe('allowlist mode', () => {
  const strict = compilePolicy({ mode: 'allowlist', deny: DEFAULT_DENY_PATTERNS, allow: ['get_ohlcv', 'list_symbols'] })

  it('permits only listed names', () => {
    expect(strict('get_ohlcv').allowed).toBe(true)
    expect(strict('list_symbols').allowed).toBe(true)
  })

  it('refuses everything else, including otherwise-harmless tools', () => {
    for (const name of ['bash', 'read_file', 'place_order', 'todo_write']) {
      expect(strict(name).allowed).toBe(false)
    }
  })

  it('ignores the deny patterns entirely', () => {
    const odd = compilePolicy({ mode: 'allowlist', deny: ['^get_'], allow: ['get_ohlcv'] })
    expect(odd('get_ohlcv').allowed).toBe(true)
  })

  it('explains the mode in the reason', () => {
    const verdict = strict('bash')
    if (verdict.allowed) throw new Error('expected a denial')
    expect(verdict.reason).toContain('allowlist mode')
  })
})
