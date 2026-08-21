/**
 * Symbol and timeframe resolution. These enum values are transcribed from the
 * protobuf definitions `futu-api` ships; pinning them here means an SDK bump
 * that renumbers anything fails a test instead of quietly returning candles
 * for the wrong interval or the wrong exchange.
 */
import { describe, expect, it } from 'vitest'
import {
  describeVersionSkew,
  KLType,
  parseSdkVersion,
  QotMarket,
  resolveSymbol,
  resolveTimeframe,
  SubType,
  SUPPORTED_TIMEFRAMES,
} from '../src/protocol.js'

describe('resolveSymbol', () => {
  it('routes each market prefix to its QotMarket value', () => {
    expect(resolveSymbol('HK.00700').market).toBe(QotMarket.HK_Security)
    expect(resolveSymbol('US.AAPL').market).toBe(QotMarket.US_Security)
    expect(resolveSymbol('SH.600519').market).toBe(QotMarket.CNSH_Security)
    expect(resolveSymbol('SZ.000001').market).toBe(QotMarket.CNSZ_Security)
    expect(resolveSymbol('CC.BTCUSDT').market).toBe(QotMarket.CC_Security)
  })

  it('tags crypto as its own asset class', () => {
    expect(resolveSymbol('CC.BTCUSDT').assetClass).toBe('crypto')
    expect(resolveSymbol('US.AAPL').assetClass).toBe('equity')
  })

  it('keeps the code exactly as written, leading zeros included', () => {
    expect(resolveSymbol('HK.00700').code).toBe('00700')
  })

  it('pairs each market with its exchange timezone', () => {
    expect(resolveSymbol('HK.00700').timeZone).toBe('Asia/Hong_Kong')
    expect(resolveSymbol('SH.600519').timeZone).toBe('Asia/Shanghai')
    expect(resolveSymbol('SZ.000001').timeZone).toBe('Asia/Shanghai')
    expect(resolveSymbol('US.AAPL').timeZone).toBe('America/New_York')
  })

  it('accepts a lowercase prefix', () => {
    expect(resolveSymbol('us.AAPL').market).toBe(QotMarket.US_Security)
  })

  it('does not lowercase the code — tickers are case-sensitive', () => {
    expect(resolveSymbol('us.AAPL').code).toBe('AAPL')
  })

  it('refuses an unknown market rather than guessing one', () => {
    expect(() => resolveSymbol('LSE.VOD')).toThrow(/unknown symbol/)
  })

  it('refuses a bare ticker with no market', () => {
    expect(() => resolveSymbol('AAPL')).toThrow(/unknown symbol/)
  })

  it('refuses a prefix with an empty code', () => {
    expect(() => resolveSymbol('US.')).toThrow(/unknown symbol/)
  })
})

describe('resolveTimeframe', () => {
  it('maps every supported timeframe to its KLType and funding SubType', () => {
    expect(resolveTimeframe('1m')).toEqual({ klType: KLType.KLType_1Min, subType: SubType.KL_1Min })
    expect(resolveTimeframe('5m')).toEqual({ klType: KLType.KLType_5Min, subType: SubType.KL_5Min })
    expect(resolveTimeframe('15m')).toEqual({ klType: KLType.KLType_15Min, subType: SubType.KL_15Min })
    expect(resolveTimeframe('30m')).toEqual({ klType: KLType.KLType_30Min, subType: SubType.KL_30Min })
    expect(resolveTimeframe('1h')).toEqual({ klType: KLType.KLType_60Min, subType: SubType.KL_60Min })
    expect(resolveTimeframe('4h')).toEqual({ klType: KLType.KLType_240Min, subType: SubType.KL_240Min })
    expect(resolveTimeframe('1d')).toEqual({ klType: KLType.KLType_Day, subType: SubType.KL_Day })
    expect(resolveTimeframe('1w')).toEqual({ klType: KLType.KLType_Week, subType: SubType.KL_Week })
  })

  it('covers the whole Timeframe union the seam declares', () => {
    expect([...SUPPORTED_TIMEFRAMES].sort()).toEqual(['15m', '1d', '1h', '1m', '1w', '30m', '4h', '5m'])
  })

  it('names the available set when asked for something it cannot serve', () => {
    // @ts-expect-error - deliberately outside the Timeframe union
    expect(() => resolveTimeframe('2h')).toThrow(/available/)
  })

  it('pins the wire enum values against an SDK renumbering', () => {
    expect(KLType).toMatchObject({
      KLType_1Min: 1, KLType_Day: 2, KLType_Week: 3, KLType_5Min: 6,
      KLType_15Min: 7, KLType_30Min: 8, KLType_60Min: 9, KLType_240Min: 15,
    })
    expect(SubType).toMatchObject({
      KL_Day: 6, KL_5Min: 7, KL_15Min: 8, KL_30Min: 9,
      KL_60Min: 10, KL_1Min: 11, KL_Week: 12, KL_240Min: 21,
    })
    expect(QotMarket).toMatchObject({
      HK_Security: 1, US_Security: 11, CNSH_Security: 21, CNSZ_Security: 22, CC_Security: 91,
    })
  })
})

describe('version skew', () => {
  it('splits an SDK version into Futu\'s line and build', () => {
    expect(parseSdkVersion('10.9.6908')).toEqual({ serverVer: 1009, serverBuildNo: 6908 })
    expect(parseSdkVersion('10.10.7008')).toEqual({ serverVer: 1010, serverBuildNo: 7008 })
  })

  it('returns null for a version it cannot read', () => {
    expect(parseSdkVersion('next')).toBeNull()
  })

  it('is silent when the protocol lines agree, whatever the builds', () => {
    // Builds drift within a line constantly and mean nothing; only the line is
    // a compatibility statement.
    expect(describeVersionSkew('10.9.6908', { serverVer: 1009, serverBuildNo: 6918 })).toBeNull()
  })

  it('names the mismatch and why a version range cannot express it', () => {
    const msg = describeVersionSkew('10.10.7008', { serverVer: 1009, serverBuildNo: 6918 })
    expect(msg).toContain('10.10')
    expect(msg).toContain('10.9')
    expect(msg).toMatch(/not semver/)
  })

  it('stays silent when OpenD reported nothing rather than inventing a skew', () => {
    expect(describeVersionSkew('10.9.6908', { serverVer: 0, serverBuildNo: 0 })).toBeNull()
    expect(describeVersionSkew('', { serverVer: 1009, serverBuildNo: 6918 })).toBeNull()
  })
})
