#!/usr/bin/env node
/**
 * Fetch real candles from Yahoo Finance's public chart endpoint into the CSV
 * layout `provider-csv` reads. A convenience for trying the tools against a
 * real instrument — NOT a data provider: it has no rate-limit handling, no
 * corporate-action policy, and no terms-of-use guarantee. Point the seam at a
 * real source (your broker, a vendor feed, your own store) for anything you
 * rely on; see the provider-csv package for how.
 *
 *   node examples/fetch-yahoo.mjs NBIS 1d 1y
 *   node examples/fetch-yahoo.mjs BTC-USD 1h 1mo
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [symbol, timeframe = '1d', range = '1y'] = process.argv.slice(2)
if (!symbol) {
  console.error('usage: node examples/fetch-yahoo.mjs <SYMBOL> [timeframe] [range]')
  process.exit(1)
}

// Yahoo's interval vocabulary differs from the seam's Timeframe union.
const INTERVALS = { '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '1d': '1d', '1w': '1wk' }
// Timeframes Yahoo does not serve, derived by aggregating a finer one.
const DERIVED = { '4h': { from: '1h', factor: 4 } }

const derived = DERIVED[timeframe]
const fetchTimeframe = derived ? derived.from : timeframe
const interval = INTERVALS[fetchTimeframe]
if (!interval) {
  const known = [...Object.keys(INTERVALS), ...Object.keys(DERIVED)].join(', ')
  console.error(`unsupported timeframe '${timeframe}' (have: ${known})`)
  process.exit(1)
}

/**
 * Aggregate finer bars into buckets of `factor` hours, aligned to absolute UTC
 * time rather than to the first bar, so the same instrument fetched over
 * different ranges yields the same bucket boundaries. Open is the bucket's
 * first bar, close its last, volume the sum — a partial trailing bucket is
 * kept, since dropping the most recent bar is worse than labelling it early.
 */
function aggregate(bars, hours) {
  const size = hours * 3_600_000
  const buckets = new Map()
  for (const bar of bars) {
    const bucket = Math.floor(Date.parse(bar.time) / size) * size
    const prior = buckets.get(bucket)
    if (!prior) {
      buckets.set(bucket, { ...bar, time: new Date(bucket).toISOString().replace('.000Z', 'Z') })
      continue
    }
    prior.high = Math.max(prior.high, bar.high)
    prior.low = Math.min(prior.low, bar.low)
    prior.close = bar.close
    prior.volume += bar.volume
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, bar]) => bar)
}

const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  + `?range=${encodeURIComponent(range)}&interval=${interval}`
const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
if (!response.ok) {
  console.error(`Yahoo responded ${response.status} ${response.statusText}`)
  process.exit(1)
}

const payload = await response.json()
const result = payload?.chart?.result?.[0]
if (!result) {
  console.error(`no data for ${symbol}: ${payload?.chart?.error?.description ?? 'unknown reason'}`)
  process.exit(1)
}

const { timestamp = [], indicators } = result
const q = indicators?.quote?.[0] ?? {}
let bars = []
let skipped = 0
for (let i = 0; i < timestamp.length; i++) {
  const values = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i], q.volume?.[i]]
  // Yahoo emits nulls for halted or non-trading slots. A gap is honest; an
  // interpolated bar would silently bias every indicator computed over it.
  if (values.some(v => v === null || v === undefined)) { skipped++; continue }
  const [open, high, low, close, volume] = values
  bars.push({
    time: new Date(timestamp[i] * 1000).toISOString().replace('.000Z', 'Z'),
    open, high, low, close, volume,
  })
}

const fetched = bars.length
if (derived) bars = aggregate(bars, derived.factor)

const fix = n => Number(n.toFixed(4))
const rows = bars.map(b =>
  `${b.time},${fix(b.open)},${fix(b.high)},${fix(b.low)},${fix(b.close)},${Math.round(b.volume)}`)

const root = join(dirname(fileURLToPath(import.meta.url)), 'data')
const path = join(root, symbol, `${timeframe}.csv`)
await mkdir(dirname(path), { recursive: true })
await writeFile(path, `time,open,high,low,close,volume\n${rows.join('\n')}\n`)
const note = [
  skipped > 0 ? `skipped ${skipped} incomplete` : null,
  derived ? `aggregated from ${fetched} ${derived.from} bars` : null,
].filter(Boolean).join(', ')
console.log(`wrote ${rows.length} bars to ${path}${note ? ` (${note})` : ''}`)
console.log(`range: ${rows[0]?.split(',')[0]} … ${rows.at(-1)?.split(',')[0]}`)
