/**
 * Reading an instrument out of what the reader typed.
 *
 * The chart column follows the conversation, but only once the model has called
 * a tool — twenty to forty seconds after the question. This module is the other
 * half: enough parsing to move the chart the moment the message is sent, and
 * nothing more. It never decides an analysis, and a wrong guess costs a chart
 * the model is about to correct anyway.
 *
 * Two kinds of answer, because they need different confidence:
 * - `symbol` — the text already IS a symbol (`NVDA`, `0700.HK`, `BTC-USD`), or a
 *   name whose ticker is not in doubt (`腾讯`, `茅台`). Load it straight away.
 * - `query` — a short lower-case word that might be a company (`tesla`, `tsmc`).
 *   The caller resolves it and accepts only an exact ticker or a name match,
 *   which is what keeps `buy` and `see` from opening a chart.
 * @module
 */

/** What one message might be pointing the chart at. */
export interface SymbolCandidate {
  /** The symbol itself, or the text to resolve through the provider's search. */
  value: string
  kind: 'symbol' | 'query'
}

/**
 * Chinese and English names for instruments this demo is likely to be asked
 * about, mapped to the symbol the public feed can chart.
 *
 * Yahoo's search answers `nvidia` and `0700.HK` but not `英伟达`, so the mapping
 * cannot live there. This is a demo-sized table on purpose: a name that is not
 * here still reaches the model, which resolves it itself — the table only buys
 * the first two seconds of feedback.
 */
const ALIASES: Record<string, string> = {
  腾讯: '0700.HK',
  阿里巴巴: 'BABA',
  阿里: 'BABA',
  贵州茅台: '600519.SS',
  茅台: '600519.SS',
  宁德时代: '300750.SZ',
  比亚迪: '002594.SZ',
  招商银行: '3968.HK',
  工商银行: '1398.HK',
  中国平安: '2318.HK',
  平安: '2318.HK',
  中芯国际: '0981.HK',
  中芯: '0981.HK',
  小米: '1810.HK',
  美团: '3690.HK',
  京东: 'JD',
  拼多多: 'PDD',
  百度: 'BIDU',
  网易: 'NTES',
  快手: '1024.HK',
  海底捞: '6862.HK',
  农夫山泉: '9633.HK',
  港交所: '0388.HK',
  香港交易所: '0388.HK',
  汇丰: '0005.HK',
  友邦: '1299.HK',
  中国移动: '0941.HK',
  蔚来: 'NIO',
  理想汽车: 'LI',
  小鹏汽车: 'XPEV',
  台积电: 'TSM',
  英伟达: 'NVDA',
  特斯拉: 'TSLA',
  苹果: 'AAPL',
  微软: 'MSFT',
  谷歌: 'GOOGL',
  亚马逊: 'AMZN',
  脸书: 'META',
  博通: 'AVGO',
  美光: 'MU',
  英特尔: 'INTC',
  超微: 'AMD',
  甲骨文: 'ORCL',
  奈飞: 'NFLX',
  迪士尼: 'DIS',
  波音: 'BA',
  沃尔玛: 'WMT',
  可口可乐: 'KO',
  摩根大通: 'JPM',
  高盛: 'GS',
  伯克希尔: 'BRK-B',
  比特币: 'BTC-USD',
  大饼: 'BTC-USD',
  以太坊: 'ETH-USD',
  以太币: 'ETH-USD',
  索拉纳: 'SOL-USD',
  黄金: 'GC=F',
  原油: 'CL=F',
  白银: 'SI=F',
  纳指: '^IXIC',
  纳斯达克: '^IXIC',
  标普500: '^GSPC',
  标普: '^GSPC',
  道指: '^DJI',
  道琼斯: '^DJI',
  恒生: '^HSI',
  恒指: '^HSI',
  沪深300: '000300.SS',
  上证: '000001.SS',
}

/**
 * Tokens that are never an instrument. Finance vocabulary first — a chart
 * question is full of it — then the words an English request is made of, which
 * is what keeps "buy now or wait" from opening BUY.
 */
const NOT_TICKERS = new Set([
  // indicators and structure
  'RSI', 'MACD', 'EMA', 'SMA', 'MA', 'ADX', 'MFI', 'BB', 'ATR', 'OBV', 'VOL', 'VWAP', 'KDJ', 'CCI',
  'BOLL', 'DMI', 'SAR', 'TP', 'SL', 'RR', 'PNL', 'TP1', 'TP2', 'TP3', 'SL1',
  // fundamentals and trading
  'PE', 'PB', 'EPS', 'ROE', 'IPO', 'CEO', 'CFO', 'AI', 'LLM', 'API', 'ETF', 'ETN', 'NAV',
  'BUY', 'SELL', 'LONG', 'SHORT', 'STOP', 'LIMIT', 'CALL', 'PUT', 'BID', 'ASK', 'SPREAD',
  // currencies and places
  'USD', 'CNY', 'HKD', 'EUR', 'JPY', 'GBP', 'US', 'HK', 'CN', 'SG', 'JP', 'UK', 'EU',
  // time
  'AM', 'PM', 'UTC', 'EST', 'ET', 'PT', 'YTD', 'QOQ', 'YOY', 'EOD', 'EOW', 'TODAY',
  'WEEK', 'MONTH', 'YEAR', 'NOW', 'NEXT', 'LAST', 'FIRST',
  // ordinary English a request is built from
  'A', 'I', 'AN', 'OK', 'AND', 'THE', 'FOR', 'NOT', 'BUT', 'CAN', 'WILL', 'WAS', 'ARE',
  'SEE', 'LOOK', 'SHOW', 'TELL', 'GIVE', 'GOOD', 'BAD', 'NEW', 'OLD', 'BIG', 'SMALL',
  'WHAT', 'WHEN', 'WHERE', 'WHY', 'HOW', 'THIS', 'THAT', 'THESE', 'THOSE', 'IT', 'IS',
  'MY', 'ME', 'YOU', 'WE', 'HE', 'SHE', 'THEY', 'DO', 'DOES', 'DID', 'HAS', 'HAVE',
  'PRICE', 'CHART', 'TREND', 'NEWS', 'MOVE', 'MORE', 'LESS', 'UP', 'DOWN', 'HIGH',
  'LOW', 'OPEN', 'CLOSE', 'VOLUME', 'SUPPORT', 'RESISTANCE', 'RISK', 'ENTRY', 'EXIT',
  'OR', 'AND', 'NOT', 'BUT', 'WAIT', 'HOLD', 'KEEP', 'TAKE', 'MAKE', 'WANT', 'NEED',
  'ABOUT', 'AGAIN', 'STILL', 'JUST', 'ONLY', 'ALSO', 'THEN', 'THAN', 'WITH', 'FROM',
  'INTO', 'OVER', 'UNDER', 'SINCE', 'WHILE', 'WHICH', 'THERE', 'THEIR', 'WOULD', 'COULD',
  'SHOULD', 'MAYBE', 'PLEASE', 'THANKS', 'HELLO', 'YES', 'YEAH', 'NO', 'OKAY',
])

/**
 * Words that may follow a company name without making it a different company:
 * `Tesla, Inc.` is Tesla, `Apple Hospitality REIT` is not Apple.
 */
const NAME_TAIL = new Set([
  'inc', 'inc.', 'corp', 'corp.', 'corporation', 'company', 'co', 'co.', 'group', 'holdings',
  'holding', 'ltd', 'ltd.', 'limited', 'plc', 'class', 'adr', 'sa', 'nv', 'ag', 'se', 'ab',
  'spa', 'oyj', 'asa', 'kk', 'trust', 'etf', 'fund', 'index', 'stock', 'ordinary', 'shares',
])

/**
 * Broker notation, rewritten to what this feed serves.
 *
 * Readers arrive from Futu and TradingView, where the same listing is `US.MU`,
 * `HK.00700`, `SH.600519`. Yahoo wants `MU`, `0700.HK`, `600519.SS`, and a
 * chart that refuses `US.MU` looks broken rather than mistranslated.
 * @param symbol - whatever the reader typed.
 * @returns the same instrument in this feed's notation.
 */
export function normaliseBrokerSymbol(symbol: string): string {
  const raw = symbol.trim()
  const prefixed = /^(US|HK|SH|SZ|JP)\.([A-Za-z0-9.]+)$/.exec(raw)
  if (prefixed === null) return raw
  const market = prefixed[1] as string
  const code = prefixed[2] as string
  const digits = code.replace(/^0+(?=\d)/, '')
  switch (market) {
    case 'US': return code.toUpperCase()
    case 'HK': return `${digits.padStart(4, '0')}.HK`
    case 'SH': return `${digits.padStart(6, '0')}.SS`
    case 'SZ': return `${digits.padStart(6, '0')}.SZ`
    case 'JP': return `${digits}.T`
    default: return raw
  }
}

/** A token that is already a symbol: `NVDA`, `0700.HK`, `BTC-USD`, `^GSPC`, `GC=F`. */
const SYMBOL_PATTERN = /(?<![A-Za-z0-9])(\$?(?:[A-Z]{2,6}=[XF]|\^?[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z0-9]{1,6})?))(?![A-Za-z0-9])/g

/** A Hong Kong / mainland listing: `0700.HK`, `600519.SS`, `300750.SZ`. */
const NUMBERED_PATTERN = /(?<![A-Za-z0-9])(\d{4,6}\.(?:HK|SS|SZ|TW|T))(?![A-Za-z0-9])/gi

/** A short lower-case word worth resolving: `tesla`, `tsmc`, `nvda`. */
const WORD_PATTERN = /(?<![A-Za-z0-9])([a-z]{3,8})(?![A-Za-z0-9])/g

/**
 * Read the instruments one message might be about, best first.
 *
 * Aliases are matched on the raw text (they are unambiguous), then explicit
 * symbols, then lower-case words left for the caller to verify.
 * @param text - the reader's message, as typed.
 * @returns candidates in the order they appear; empty when nothing looks like an instrument.
 */
export function readSymbolCandidates(text: string): SymbolCandidate[] {
  const found: { at: number; candidate: SymbolCandidate }[] = []

  for (const [alias, symbol] of Object.entries(ALIASES)) {
    const at = text.indexOf(alias)
    if (at >= 0) found.push({ at, candidate: { value: symbol, kind: 'symbol' } })
  }

  for (const match of text.matchAll(NUMBERED_PATTERN)) {
    const token = match[1]
    if (token !== undefined) found.push({ at: match.index, candidate: { value: token.toUpperCase(), kind: 'symbol' } })
  }

  for (const match of text.matchAll(SYMBOL_PATTERN)) {
    const raw = match[1]
    if (raw === undefined) continue
    const token = raw.replace(/^\$/, '')
    if (NOT_TICKERS.has(token)) continue
    // A single letter is a pronoun, not a listing.
    if (token.length < 2) continue
    found.push({ at: match.index, candidate: { value: normaliseBrokerSymbol(token), kind: 'symbol' } })
  }

  for (const match of text.matchAll(WORD_PATTERN)) {
    const token = match[1]
    if (token === undefined) continue
    if (NOT_TICKERS.has(token.toUpperCase())) continue
    found.push({ at: match.index, candidate: { value: token, kind: 'query' } })
  }

  // The reader's order is the order of interest, so the first name mentioned
  // wins — not the order of a table someone maintained.
  found.sort((a, b) => a.at - b.at)
  const out: SymbolCandidate[] = []
  const seen = new Set<string>()
  for (const { candidate } of found) {
    const key = candidate.value.toUpperCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
  }
  return out
}

/**
 * Whether a search hit is the thing the reader named.
 *
 * Exact ticker, or a name that starts with what they typed — the rule that lets
 * `tesla` resolve to TSLA while `buy` resolves to nothing.
 * @param query - the lower-case word from the message.
 * @param item - one search hit.
 * @returns true when the hit can stand in for the word.
 */
export function isSameInstrument(query: string, item: { symbol: string; name?: string }): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return false
  if (item.symbol.toLowerCase() === q) return true
  const name = item.name?.toLowerCase() ?? ''
  if (name === '') return false
  const words = name.split(/[\s,]+/).filter(w => w !== '')
  if (words[0] !== q) return false
  // Same first word is not enough: "Apple Hospitality REIT" must not stand in
  // for Apple. What may follow is a corporate suffix and nothing else.
  return words.slice(1).every(w => NAME_TAIL.has(w))
}
