/**
 * `search`: the name lookup behind `resolve_symbol` and behind the chart column
 * moving the moment a reader names an instrument.
 *
 * The cases here are the ones a public demo actually gets: a Chinese company
 * name (which Yahoo's index does not answer), broker notation from Futu and
 * TradingView, and a Latin ticker that is already in the catalogue. None of
 * them should need the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketDataProvider } from '@dsh-trading/market-data'
import { apply } from '../src/index.js'

function mount(): MarketDataProvider {
  const registered: MarketDataProvider[] = []
  const ctx = {
    effect: (run: () => () => void) => void run(),
    marketData: {
      register: (provider: MarketDataProvider) => {
        registered.push(provider)
        return () => {}
      },
    },
  }
  apply(ctx, { id: 'public', baseURL: 'https://yahoo.test', cacheMs: 20_000, dailyCacheMs: 300_000 })
  return registered[0]!
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('search', () => {
  it('answers a Chinese name from the local table, without touching the network', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const hits = await mount().search?.('腾讯')
    expect(hits?.[0]?.symbol).toBe('0700.HK')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rewrites broker notation into this feed notation', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const provider = mount()
    expect((await provider.search?.('US.MU'))?.[0]?.symbol).toBe('MU')
    expect((await provider.search?.('HK.00700'))?.[0]?.symbol).toBe('0700.HK')
    expect((await provider.search?.('SH.600519'))?.[0]?.symbol).toBe('600519.SS')
  })

  it('answers pinyin and English spellings of the same listing', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const provider = mount()
    expect((await provider.search?.('tengxun'))?.[0]?.symbol).toBe('0700.HK')
    expect((await provider.search?.('tencent'))?.[0]?.symbol).toBe('0700.HK')
    expect((await provider.search?.('taijidian'))?.[0]?.symbol).toBe('TSM')
    expect((await provider.search?.('maotai'))?.[0]?.symbol).toBe('600519.SS')
    expect((await provider.search?.('bitcoin'))?.[0]?.symbol).toBe('BTC-USD')
  })

  it('finds a name inside a sentence, longest name first', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const provider = mount()
    expect((await provider.search?.('腾讯怎么样'))?.[0]?.symbol).toBe('0700.HK')
    expect((await provider.search?.('看看贵州茅台'))?.[0]?.symbol).toBe('600519.SS')
    expect((await provider.search?.('what about bitcoin today'))?.[0]?.symbol).toBe('BTC-USD')
  })

  it('does not fire a Latin name inside another word', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ quotes: [] }))))
    // "gold" must not be found inside "goldman".
    expect(await mount().search?.('goldman sachs upgrade')).toEqual([])
  })

  it('finds a catalogued symbol by its own name', async () => {
    vi.stubGlobal('fetch', vi.fn())
    expect((await mount().search?.('NVDA'))?.[0]?.symbol).toBe('NVDA')
  })

  it('answers nothing for an empty query', async () => {
    expect(await mount().search?.('   ')).toEqual([])
  })

  it('degrades to no matches when Yahoo rate-limits, instead of failing the call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })))
    expect(await mount().search?.('some unknown name')).toEqual([])
  })

  it('reads Yahoo results for a name the table does not know', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      quotes: [
        { symbol: 'ASML', shortname: 'ASML Holding', quoteType: 'EQUITY' },
        { symbol: 'ASML34.SA', shortname: 'ASML HOLDING DRN', quoteType: 'EQUITY' },
        { symbol: 'NOTHING', quoteType: 'MUTUALFUND_ODD' },
      ],
    }))))
    const hits = await mount().search?.('asml')
    expect(hits?.map(h => h.symbol)).toEqual(['ASML', 'ASML34.SA'])
  })
})
