/**
 * Reading an instrument out of what the reader typed.
 *
 * The chart column follows the conversation, but only once the model has called
 * a tool — twenty to forty seconds after the question. This module is the other
 * half: enough parsing to move the chart the moment the message is sent, and
 * nothing more. It never decides an analysis, and a wrong guess costs a chart
 * the model is about to correct anyway.
 *
 * Three kinds of answer, because they need different confidence:
 * - `symbol` — the text already IS a symbol (`NVDA`, `0700.HK`, `BTC-USD`).
 *   Load it straight away.
 * - `text` — a Chinese name (`腾讯`), left to the provider's table, which also
 *   carries pinyin and English spellings.
 * - `query` — a short lower-case word that might be a company (`tesla`, `tsmc`).
 *   The caller accepts only an exact ticker or a name match, which is what
 *   keeps `buy` and `see` from opening a chart.
 * @module
 */

/** What one message might be pointing the chart at. */
export interface SymbolCandidate {
  /** The symbol itself, or the text to resolve through the provider's search. */
  value: string
  /**
   * `symbol` — load it as written. `query` — a Latin word the caller must
   * verify is that company. `text` — a name (Chinese, pinyin, English) the
   * provider's own table decides.
   */
  kind: 'symbol' | 'query' | 'text'
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
const SYMBOL_PATTERN = /(?<![A-Za-z0-9.])(\$?(?:[A-Z]{2,6}=[XF]|\^?[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z0-9]{1,6})?))(?![A-Za-z0-9])/g

/** A Hong Kong / mainland listing: `0700.HK`, `600519.SS`, `300750.SZ`. */
const NUMBERED_PATTERN = /(?<![A-Za-z0-9])(\d{4,6}\.(?:HK|SS|SZ|TW|T))(?![A-Za-z0-9])/gi

/** A short lower-case word worth resolving: `tesla`, `tsmc`, `nvda`. */
const WORD_PATTERN = /(?<![A-Za-z0-9])([a-z]{3,8})(?![A-Za-z0-9])/g

/** A run of Chinese: a company name to look up, not a ticker to trust. */
const CJK_PATTERN = /[\u4e00-\u9fff]{2,}/g

/** Longer than this and the run is a sentence, not a name. */
const CJK_NAME_MAX = 10

/**
 * Read the instruments one message might be about, best first.
 *
 * Explicit symbols are read here; names — Chinese, pinyin or English — are
 * handed to the provider, which owns the table, so the two can never drift.
 * @param text - the reader's message, as typed.
 * @returns candidates in the order they appear; empty when nothing looks like an instrument.
 */
export function readSymbolCandidates(text: string): SymbolCandidate[] {
  const found: { at: number; candidate: SymbolCandidate }[] = []

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

  for (const match of text.matchAll(CJK_PATTERN)) {
    const run = match[0]
    // A long run is a sentence ("直接告诉我两个关键价位"), not a company name;
    // sending it to the provider would cost a lookup to learn nothing.
    if (run !== undefined && run.length <= CJK_NAME_MAX) {
      found.push({ at: match.index, candidate: { value: run, kind: 'text' } })
    }
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
