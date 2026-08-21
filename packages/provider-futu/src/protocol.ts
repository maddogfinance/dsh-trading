/**
 * The pure half of the Futu provider: symbol parsing, timeframe mapping, and
 * candle normalisation. No SDK import, no socket — everything here is a total
 * function over values, so the parts that are easy to get subtly wrong are the
 * parts that are cheap to test.
 *
 * Enum values are transcribed from the protobuf definitions the `futu-api`
 * package itself ships (`Qot_Common.proto`), not from prose documentation.
 * @module
 */

import type { Timeframe } from '@dsh-trading/market-data'

/** `Qot_Common.QotMarket` — the markets this provider addresses. */
export const QotMarket = {
  HK_Security: 1,
  US_Security: 11,
  CNSH_Security: 21,
  CNSZ_Security: 22,
  CC_Security: 91,
} as const

/** `Qot_Common.KLType`. */
export const KLType = {
  KLType_1Min: 1,
  KLType_Day: 2,
  KLType_Week: 3,
  KLType_5Min: 6,
  KLType_15Min: 7,
  KLType_30Min: 8,
  KLType_60Min: 9,
  KLType_240Min: 15,
} as const

/** `Qot_Common.SubType` — the subscription that funds a `Qot_GetKL` read. */
export const SubType = {
  KL_Day: 6,
  KL_5Min: 7,
  KL_15Min: 8,
  KL_30Min: 9,
  KL_60Min: 10,
  KL_1Min: 11,
  KL_Week: 12,
  KL_240Min: 21,
} as const

/** `Qot_Common.RehabType`. Forward adjustment is what a chart should show. */
export const RehabType = { None: 0, Forward: 1, Backward: 2 } as const

/** One market's addressing rules. */
interface MarketSpec {
  readonly market: number
  /** IANA zone of the exchange's wall clock — only a fallback, see {@link toCandle}. */
  readonly timeZone: string
  readonly assetClass: string
}

/**
 * Symbol prefixes, matching Futu's own `HK.00700` / `US.AAPL` notation. Using
 * the vendor's native form on purpose: a symbol the user can paste straight
 * out of the Futu app is worth more than a prettier scheme of our own.
 */
const MARKETS: Readonly<Record<string, MarketSpec>> = {
  HK: { market: QotMarket.HK_Security, timeZone: 'Asia/Hong_Kong', assetClass: 'equity' },
  US: { market: QotMarket.US_Security, timeZone: 'America/New_York', assetClass: 'equity' },
  SH: { market: QotMarket.CNSH_Security, timeZone: 'Asia/Shanghai', assetClass: 'equity' },
  SZ: { market: QotMarket.CNSZ_Security, timeZone: 'Asia/Shanghai', assetClass: 'equity' },
  // Crypto trades around the clock, which makes it the one instrument class
  // that can prove a live feed at any hour. Futu prints its bars on the US
  // Eastern wall clock; the zone here only feeds the pre-epoch fallback, since
  // every modern bar carries an unambiguous `timestamp`.
  CC: { market: QotMarket.CC_Security, timeZone: 'America/New_York', assetClass: 'crypto' },
}

/** A symbol resolved to what the wire needs. */
export interface ResolvedSymbol {
  readonly market: number
  readonly code: string
  readonly timeZone: string
  readonly assetClass: string
}

/**
 * Resolve `HK.00700` into a Futu security. Throws on anything else rather than
 * guessing a market: a mis-routed symbol would return real candles for the
 * wrong instrument, which is worse than an error.
 * @param symbol - provider-scoped symbol, `<MARKET>.<CODE>`.
 * @returns the wire security plus display metadata.
 */
export function resolveSymbol(symbol: string): ResolvedSymbol {
  const dot = symbol.indexOf('.')
  const prefix = dot === -1 ? '' : symbol.slice(0, dot).toUpperCase()
  const code = dot === -1 ? '' : symbol.slice(dot + 1)
  const spec = MARKETS[prefix]
  if (spec === undefined || code === '') {
    throw new Error(
      `unknown symbol '${symbol}': expected <MARKET>.<CODE> with MARKET one of ${Object.keys(MARKETS).join(', ')} (e.g. HK.00700, US.AAPL, CC.BTCUSDT)`,
    )
  }
  return { market: spec.market, code, timeZone: spec.timeZone, assetClass: spec.assetClass }
}

/** Timeframes this provider serves, and the two enums each one needs. */
const TIMEFRAMES: Readonly<Partial<Record<Timeframe, { klType: number; subType: number }>>> = {
  '1m': { klType: KLType.KLType_1Min, subType: SubType.KL_1Min },
  '5m': { klType: KLType.KLType_5Min, subType: SubType.KL_5Min },
  '15m': { klType: KLType.KLType_15Min, subType: SubType.KL_15Min },
  '30m': { klType: KLType.KLType_30Min, subType: SubType.KL_30Min },
  '1h': { klType: KLType.KLType_60Min, subType: SubType.KL_60Min },
  '4h': { klType: KLType.KLType_240Min, subType: SubType.KL_240Min },
  '1d': { klType: KLType.KLType_Day, subType: SubType.KL_Day },
  '1w': { klType: KLType.KLType_Week, subType: SubType.KL_Week },
}

/** The timeframes this provider can serve, for `InstrumentInfo.timeframes`. */
export const SUPPORTED_TIMEFRAMES: readonly Timeframe[] = Object.keys(TIMEFRAMES) as Timeframe[]

/**
 * Map a seam timeframe to the Futu enums.
 * @param timeframe - the requested bar interval.
 * @returns the KLType to read and the SubType that funds the read.
 */
export function resolveTimeframe(timeframe: Timeframe): { klType: number; subType: number } {
  const found = TIMEFRAMES[timeframe]
  if (found === undefined) {
    throw new Error(`Futu does not serve '${timeframe}' (available: ${SUPPORTED_TIMEFRAMES.join(', ')})`)
  }
  return found
}

/**
 * Futu's own version line, as `Qot`'s `GetGlobalState` reports it: `serverVer`
 * is major*100 + minor (10.9 arrives as 1009) and `serverBuildNo` is the build.
 */
export interface OpenDVersion {
  serverVer: number
  serverBuildNo: number
}

/** The SDK's version split the same way, or null when unparsable. */
export function parseSdkVersion(version: string): OpenDVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim())
  if (m === null) return null
  return { serverVer: Number(m[1]) * 100 + Number(m[2]), serverBuildNo: Number(m[3]) }
}

/**
 * Describe a protocol-line skew between the installed SDK and the running
 * OpenD, or null when they agree.
 *
 * Only the LINE (major.minor) is a compatibility statement; builds drift
 * routinely within a line and mean nothing. Futu states outright that its
 * package versions do not follow npm's semver rules, so this cannot be
 * delegated to a version range in `package.json` — a caret would silently
 * accept a package whose wire protocol has moved.
 *
 * @param sdkVersion - the installed `futu-api` version string.
 * @param opend - what GetGlobalState reported.
 * @returns a message naming the fix, or null when the lines match.
 */
export function describeVersionSkew(sdkVersion: string, opend: OpenDVersion): string | null {
  const sdk = parseSdkVersion(sdkVersion)
  if (sdk === null || opend.serverVer === 0) return null
  if (sdk.serverVer === opend.serverVer) return null
  const line = (v: number): string => `${Math.floor(v / 100)}.${v % 100}`
  return (
    `futu-api ${sdkVersion} speaks protocol line ${line(sdk.serverVer)}, but OpenD `
    + `reports ${line(opend.serverVer)} (build ${opend.serverBuildNo}). Install the futu-api `
    + `matching your OpenD — Futu versions its packages on its own scheme, not semver, `
    + `so a version RANGE cannot express this and the two must be aligned by hand.`
  )
}
