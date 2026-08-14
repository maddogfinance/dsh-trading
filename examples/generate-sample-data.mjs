#!/usr/bin/env node
/**
 * Regenerate examples/data: deterministic synthetic candles (mulberry32 PRNG,
 * fixed seeds) so the demo fixture is reproducible and reviewably fake —
 * sample data in an open-source trading repo must never look like real quotes.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), 'data')

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function candles({ seed, start, stepMs, count, price, vol, volume }) {
  const rand = mulberry32(seed)
  const rows = []
  let close = price
  let t = Date.parse(start)
  for (let i = 0; i < count; i++) {
    const open = close
    const drift = (rand() - 0.5) * 2 * vol * open
    close = Math.max(open + drift, open * 0.85)
    const high = Math.max(open, close) * (1 + rand() * vol * 0.5)
    const low = Math.min(open, close) * (1 - rand() * vol * 0.5)
    const v = Math.round(volume * (0.5 + rand()))
    const fix = n => Number(n.toFixed(4))
    rows.push(`${new Date(t).toISOString().replace('.000Z', 'Z')},${fix(open)},${fix(high)},${fix(low)},${fix(close)},${v}`)
    t += stepMs
  }
  return `time,open,high,low,close,volume\n${rows.join('\n')}\n`
}

const DAY = 86_400_000
const HOUR = 3_600_000
const series = [
  ['DEMO-EQ/1d.csv', { seed: 1001, start: '2025-08-01T00:00:00Z', stepMs: DAY, count: 250, price: 100, vol: 0.02, volume: 1_000_000 }],
  ['DEMO-EQ/1h.csv', { seed: 1002, start: '2026-07-01T00:00:00Z', stepMs: HOUR, count: 500, price: 100, vol: 0.006, volume: 80_000 }],
  ['DEMO-COIN/1h.csv', { seed: 2001, start: '2026-07-01T00:00:00Z', stepMs: HOUR, count: 500, price: 30_000, vol: 0.012, volume: 500 }],
]

for (const [file, spec] of series) {
  const path = join(root, file)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, candles(spec))
  console.log('wrote', path)
}
