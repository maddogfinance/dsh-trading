import { describe, expect, it } from 'vitest'
import { isSameInstrument, normaliseBrokerSymbol, readSymbolCandidates } from '../src/client/symbols.js'

const values = (text: string) => readSymbolCandidates(text).map(c => `${c.kind}:${c.value}`)
const symbols = (text: string) => readSymbolCandidates(text).filter(c => c.kind === 'symbol').map(c => c.value)

describe('readSymbolCandidates', () => {
  it('reads an explicit ticker', () => {
    expect(symbols('我想看看 AAPL')).toEqual(['AAPL'])
  })

  it('hands a Chinese name to the provider instead of guessing a ticker', () => {
    expect(values('腾讯怎么样')).toEqual(['text:腾讯怎么样'])
  })

  it('reads exchange suffixes, crypto pairs, indices and futures', () => {
    expect(symbols('0700.HK 怎么样')).toEqual(['0700.HK'])
    expect(symbols('BTC-USD 现在')).toEqual(['BTC-USD'])
    expect(symbols('看看 ^GSPC')).toEqual(['^GSPC'])
    expect(symbols('原油 GC=F')).toEqual(['GC=F'])
    expect(symbols('600519.SS')).toEqual(['600519.SS'])
  })

  it('leaves a lower-case word for the caller to verify', () => {
    expect(values('看看 tesla')).toEqual(['text:看看', 'query:tesla'])
  })

  it('emits no ticker for indicator vocabulary or ordinary English', () => {
    expect(symbols('RSI 和 MACD 怎么看')).toEqual([])
    expect(symbols('buy now or wait')).toEqual([])
    expect(symbols('show me the trend please')).toEqual([])
  })

  it('keeps the reader order between a ticker and a name', () => {
    // The panel walks this list in order, so the first name that resolves is
    // the one the reader said first.
    expect(values('先看 NVDA 再看 腾讯')).toEqual(['text:先看', 'symbol:NVDA', 'text:再看', 'text:腾讯'])
    expect(values('先看 腾讯 再看 NVDA')).toEqual(['text:先看', 'text:腾讯', 'text:再看', 'symbol:NVDA'])
  })

  it('drops a sentence-length run of Chinese', () => {
    expect(values('别绕了，直接告诉我两个关键价位')).toEqual(['text:别绕了'])
  })

  it('dedupes the same instrument named twice', () => {
    expect(symbols('AAPL，还是 AAPL')).toEqual(['AAPL'])
  })

  it('finds no ticker in a message about nothing', () => {
    // A Chinese sentence still reaches the provider as a name to try; what it
    // must never produce is a ticker the panel would load blind.
    expect(symbols('你看一下左边这个')).toEqual([])
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
    expect(symbols('看看 US.MU')).toEqual(['MU'])
    expect(symbols('HK.00700 怎么样')).toEqual(['0700.HK'])
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
