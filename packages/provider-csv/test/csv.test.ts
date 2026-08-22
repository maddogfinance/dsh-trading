/**
 * Tests for @dsh-trading/provider-csv: the parseCsv contract (fail loud on
 * shape drift) and the plugin surface — `apply` mounts exactly one provider
 * on the marketData hub, and that provider honours the MarketDataProvider
 * contract over a real on-disk fixture tree.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { MarketDataProvider } from '@dsh-trading/market-data'
import { apply, parseCsv } from '../src/index.js'

const HEADER = 'time,open,high,low,close,volume'

/** Five ascending daily bars; boundary times are reused in range tests. */
const ROWS = [
  '2024-01-01T00:00:00Z,10,12,9,11,100',
  '2024-01-02T00:00:00Z,11,13,10,12,200',
  '2024-01-03T00:00:00Z,12,14,11,13,300',
  '2024-01-04T00:00:00Z,13,15,12,14,400',
  '2024-01-05T00:00:00Z,14,16,13,15,500',
]
const BODY = [HEADER, ...ROWS].join('\n')

const tmpDirs: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'provider-csv-test-'))
  tmpDirs.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * Run `apply` against a stub ctx whose `effect` runs the callback eagerly and
 * whose `marketData.register` only captures — the narrowest surface the
 * plugin contract actually touches, so no cordis runtime is needed.
 */
function mount(config: { root: string; id?: string }): MarketDataProvider[] {
  const registered: MarketDataProvider[] = []
  const ctx = {
    effect: (fn: () => unknown) => void fn(),
    marketData: {
      register: (provider: MarketDataProvider) => {
        registered.push(provider)
        return () => {}
      },
    },
  }
  apply(ctx as unknown as Parameters<typeof apply>[0], config)
  return registered
}

/** Mount over `root` and return the sole registered provider. */
function mountProvider(root: string): MarketDataProvider {
  const registered = mount({ root })
  expect(registered).toHaveLength(1)
  return registered[0]!
}

describe('parseCsv', () => {
  it('parses header plus rows into candles', () => {
    const candles = parseCsv(BODY, 'fixture.csv')
    expect(candles).toHaveLength(5)
    expect(candles[0]).toEqual({
      time: '2024-01-01T00:00:00Z',
      open: 10,
      high: 12,
      low: 9,
      close: 11,
      volume: 100,
    })
    expect(candles[4]!.close).toBe(15)
  })

  it('accepts CRLF line endings', () => {
    const body = [HEADER, ...ROWS].join('\r\n')
    expect(parseCsv(body, 'fixture.csv')).toEqual(parseCsv(BODY, 'fixture.csv'))
  })

  it('ignores blank trailing lines', () => {
    expect(parseCsv(`${BODY}\n\n\n`, 'fixture.csv')).toHaveLength(5)
  })

  it('rejects a wrong header, naming the file', () => {
    expect(() => parseCsv(`time,open\n${ROWS[0]}`, 'fixture.csv')).toThrow(
      `fixture.csv: first line must be '${HEADER}' (got 'time,open')`,
    )
  })

  it('rejects an empty body as a missing header', () => {
    expect(() => parseCsv('', 'fixture.csv')).toThrow(`fixture.csv: first line must be '${HEADER}'`)
  })

  it('rejects a wrong column count with a 1-based line number', () => {
    // Second data row is physical line 3 (line 1 is the header).
    const body = [HEADER, ROWS[0], '2024-01-02T00:00:00Z,11,13,10,12'].join('\n')
    expect(() => parseCsv(body, 'fixture.csv')).toThrow('fixture.csv:3: expected 6 columns, got 5')
  })

  it('rejects an unparsable time', () => {
    const body = [HEADER, 'not-a-time,10,12,9,11,100'].join('\n')
    expect(() => parseCsv(body, 'fixture.csv')).toThrow("fixture.csv:2: unparsable time 'not-a-time'")
  })

  it('rejects a non-numeric cell', () => {
    const body = [HEADER, '2024-01-01T00:00:00Z,abc,12,9,11,100'].join('\n')
    expect(() => parseCsv(body, 'fixture.csv')).toThrow('fixture.csv:2: non-numeric OHLCV cell')
  })

  it("rejects the literal string 'NaN' (Number('NaN') is NaN, not a value)", () => {
    const body = [HEADER, '2024-01-01T00:00:00Z,10,12,9,11,NaN'].join('\n')
    expect(() => parseCsv(body, 'fixture.csv')).toThrow('fixture.csv:2: non-numeric OHLCV cell')
  })

  it('rejects an open or close outside the reported low/high range', () => {
    for (const row of [
      '2024-01-01T00:00:00Z,10,9,8,8.5,100',
      '2024-01-01T00:00:00Z,10,11,10.5,10,100',
    ]) {
      expect(() => parseCsv([HEADER, row].join('\n'), 'fixture.csv')).toThrow(
        'fixture.csv:2: OHLC must satisfy low <= open/close <= high',
      )
    }
  })

  it('rejects negative volume', () => {
    const body = [HEADER, '2024-01-01T00:00:00Z,10,12,9,11,-1'].join('\n')
    expect(() => parseCsv(body, 'fixture.csv')).toThrow('fixture.csv:2: volume must be non-negative')
  })
})

describe('apply', () => {
  it('registers exactly one provider, id defaulting to csv', async () => {
    const root = await makeRoot()
    const registered = mount({ root })
    expect(registered).toHaveLength(1)
    expect(registered[0]!.id).toBe('csv')
    expect(registered[0]!.description).toContain(root)
  })

  it('honours a custom id', async () => {
    const root = await makeRoot()
    const registered = mount({ root, id: 'my-store' })
    expect(registered.map(p => p.id)).toEqual(['my-store'])
  })
})

describe('CsvProvider.listSymbols', () => {
  it('returns [] for an empty root', async () => {
    const provider = mountProvider(await makeRoot())
    expect(await provider.listSymbols()).toEqual([])
  })

  it('lists symbol directories with their recognised timeframes', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'AAPL'))
    await writeFile(join(root, 'AAPL', '1d.csv'), BODY)
    await writeFile(join(root, 'AAPL', '1h.csv'), BODY)
    await mkdir(join(root, 'BTC-USDT'))
    await writeFile(join(root, 'BTC-USDT', '1m.csv'), BODY)

    const provider = mountProvider(root)
    const bySymbol = Object.fromEntries(
      (await provider.listSymbols()).map(s => [s.symbol, [...(s.timeframes ?? [])].sort()]),
    )
    expect(bySymbol).toEqual({ AAPL: ['1d', '1h'], 'BTC-USDT': ['1m'] })
  })

  it('ignores non-csv files, unknown timeframe filenames, and root-level files', async () => {
    const root = await makeRoot()
    await mkdir(join(root, 'AAPL'))
    await writeFile(join(root, 'AAPL', '1d.csv'), BODY)
    await writeFile(join(root, 'AAPL', 'notes.txt'), 'not a candle file')
    await writeFile(join(root, 'AAPL', '2d.csv'), BODY) // unknown timeframe
    await writeFile(join(root, 'README.md'), 'not a symbol directory')
    await mkdir(join(root, 'JUNK'))
    await writeFile(join(root, 'JUNK', '3w.csv'), BODY) // no recognised timeframe: whole dir dropped

    const provider = mountProvider(root)
    expect(await provider.listSymbols()).toEqual([{ symbol: 'AAPL', timeframes: ['1d'] }])
  })
})

describe('CsvProvider.getOhlcv', () => {
  async function makeAaplRoot(): Promise<string> {
    const root = await makeRoot()
    await mkdir(join(root, 'AAPL'))
    await writeFile(join(root, 'AAPL', '1d.csv'), BODY)
    return root
  }

  it('serves the whole file without range or limit', async () => {
    const provider = mountProvider(await makeAaplRoot())
    const candles = await provider.getOhlcv({ symbol: 'AAPL', timeframe: '1d' })
    expect(candles.map(c => c.time)).toEqual(ROWS.map(r => r.split(',')[0]))
  })

  it('treats start and end as inclusive bounds', async () => {
    const provider = mountProvider(await makeAaplRoot())
    const candles = await provider.getOhlcv({
      symbol: 'AAPL',
      timeframe: '1d',
      start: '2024-01-02T00:00:00Z',
      end: '2024-01-04T00:00:00Z',
    })
    expect(candles.map(c => c.time)).toEqual([
      '2024-01-02T00:00:00Z',
      '2024-01-03T00:00:00Z',
      '2024-01-04T00:00:00Z',
    ])
  })

  it('applies limit from the end of the range', async () => {
    const provider = mountProvider(await makeAaplRoot())
    const candles = await provider.getOhlcv({ symbol: 'AAPL', timeframe: '1d', limit: 2 })
    expect(candles.map(c => c.time)).toEqual(['2024-01-04T00:00:00Z', '2024-01-05T00:00:00Z'])
  })

  it('applies limit after range filtering', async () => {
    const provider = mountProvider(await makeAaplRoot())
    const candles = await provider.getOhlcv({
      symbol: 'AAPL',
      timeframe: '1d',
      end: '2024-01-03T00:00:00Z',
      limit: 1,
    })
    expect(candles.map(c => c.time)).toEqual(['2024-01-03T00:00:00Z'])
  })

  it('rejects a missing file, naming symbol, timeframe, and expected path', async () => {
    const root = await makeAaplRoot()
    const provider = mountProvider(root)
    await expect(provider.getOhlcv({ symbol: 'MSFT', timeframe: '1h' })).rejects.toThrow(
      `no data for MSFT @ 1h (expected ${join(root, 'MSFT', '1h.csv')})`,
    )
  })
})
