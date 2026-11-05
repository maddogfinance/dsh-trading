import { describe, expect, it } from 'vitest'
import { isSameInstrument, normaliseBrokerSymbol, readSymbolCandidates } from '../src/client/symbols.js'

const values = (text: string) => readSymbolCandidates(text).map(c => `${c.kind}:${c.value}`)

describe('readSymbolCandidates', () => {
  it('reads an explicit ticker', () => {
    expect(values('我想看看 AAPL')).toEqual(['symbol:AAPL'])
  })

  it('reads a Chinese name through the alias table', () => {
    expect(values('腾讯怎么样')).toEqual(['symbol:0700.HK'])
  })

  it('collapses two aliases that mean the same listing', () => {
    expect(values('贵州茅台')).toEqual(['symbol:600519.SS'])
  })

  it('reads exchange suffixes, crypto pairs, indices and futures', () => {
    expect(values('0700.HK 怎么样')).toContain('symbol:0700.HK')
    expect(values('BTC-USD 现在')).toContain('symbol:BTC-USD')
    expect(values('看看 ^GSPC')).toContain('symbol:^GSPC')
    expect(values('原油 GC=F')).toContain('symbol:GC=F')
    expect(values('600519.SS')).toContain('symbol:600519.SS')
  })

  it('leaves a lower-case word for the caller to verify', () => {
    expect(values('看看 tesla')).toEqual(['query:tesla'])
  })

  it('ignores indicator vocabulary and ordinary English', () => {
    expect(values('RSI 和 MACD 怎么看')).toEqual([])
    expect(values('buy now or wait')).toEqual([])
    expect(values('show me the trend please')).toEqual([])
  })

  it('keeps the order the reader wrote them in', () => {
    expect(values('先看 NVDA 再看 腾讯')).toEqual(['symbol:NVDA', 'symbol:0700.HK'])
    expect(values('先看 腾讯 再看 NVDA')).toEqual(['symbol:0700.HK', 'symbol:NVDA'])
  })

  it('dedupes the same instrument named twice', () => {
    expect(values('AAPL，还是 AAPL')).toEqual(['symbol:AAPL'])
  })

  it('finds nothing in a message about nothing', () => {
    expect(values('你看一下左边这个')).toEqual([])
    expect(values('')).toEqual([])
  })
})

describe('normaliseBrokerSymbol', () => {
  it('rewrites broker notation into this feed notation', () => {
    expect(normaliseBrokerSymbol('US.MU')).toBe('MU')
    expect(normaliseBrokerSymbol('HK.00700')).toBe('0700.HK')
    expect(normaliseBrokerSymbol('SH.600519')).toBe('600519.SS')
    expect(normaliseBrokerSymbol('SZ.000001')).toBe('000001.SZ')
    expect(normaliseBrokerSymbol('AAPL')).toBe('AAPL')
  })

  it('reads a broker code in a message', () => {
    expect(values('看看 US.MU')).toEqual(['symbol:MU'])
    expect(values('HK.00700 怎么样')).toEqual(['symbol:0700.HK'])
  })
})

describe('isSameInstrument', () => {
  it('accepts the ticker itself', () => {
    expect(isSameInstrument('nvda', { symbol: 'NVDA' })).toBe(true)
  })

  it('accepts a company name followed only by a corporate suffix', () => {
    expect(isSameInstrument('tesla', { symbol: 'TSLA', name: 'Tesla, Inc.' })).toBe(true)
    expect(isSameInstrument('apple', { symbol: 'AAPL', name: 'Apple Inc.' })).toBe(true)
  })

  it('rejects a different company that merely starts with the word', () => {
    expect(isSameInstrument('apple', { symbol: 'APLE', name: 'Apple Hospitality REIT, Inc.' })).toBe(false)
    expect(isSameInstrument('buy', { symbol: 'BYY', name: 'Some Buy Corp' })).toBe(false)
  })
})
