/**
 * The analyst's pen: SVG path data for strokes that look drawn by hand. A
 * circle that overshoots its start, a line with a little bow, an arrowhead of
 * two quick ticks. The data under them stays exact; only the ink is human.
 *
 * Deterministic per mark id: the chart redraws these on every scroll and
 * zoom, and a stroke that re-randomised each time would shimmer.
 * @module
 */

export type Pt = { x: number; y: number }

/** Small seeded PRNG (mulberry32): same seed, same wobble. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a: a mark id to a seed. */
export function seedOf(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const f = (n: number): string => n.toFixed(1)

/**
 * One pen stroke from a to b: a slight bow and a little jitter at both ends.
 * The bow is capped in pixels, so a long price line stays on its price.
 */
export function stroke(a: Pt, b: Pt, r: () => number, wobble = 1): string {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const nx = -(b.y - a.y) / len
  const ny = (b.x - a.x) / len
  const bow = Math.min(len * 0.014, 2.4) * (r() * 2 - 1) * wobble
  const j = (): number => (r() - 0.5) * 1.4 * wobble
  const mx = (a.x + b.x) / 2 + nx * bow + j()
  const my = (a.y + b.y) / 2 + ny * bow + j()
  return `M${f(a.x + j())} ${f(a.y + j())} Q${f(mx)} ${f(my)} ${f(b.x + j())} ${f(b.y + j())}`
}

/** A loop the way a pen circles something: wobbly radius, overshooting where it began. */
export function loop(c: Pt, rx: number, ry: number, r: () => number): string {
  const start = r() * Math.PI * 2
  const sweep = Math.PI * 2 + 0.4 + r() * 0.3
  const n = 14
  const pts: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const t = start + (sweep * i) / n
    const k = 1 + (r() - 0.5) * 0.12 + (i / n) * 0.08
    pts.push([c.x + Math.cos(t) * rx * k, c.y + Math.sin(t) * ry * k])
  }
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[i + 2] ?? p2
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)}`
      + ` ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`
  }
  return d
}

/** A path through points, one stroke per leg; `twice` goes over it again like a pen does. */
export function polyline(pts: readonly Pt[], r: () => number, twice = false): string {
  let d = ''
  for (let i = 1; i < pts.length; i++) d += ` ${stroke(pts[i - 1]!, pts[i]!, r)}`
  if (twice) for (let i = 1; i < pts.length; i++) d += ` ${stroke(pts[i - 1]!, pts[i]!, r, 0.7)}`
  return d.trim()
}

/** Two quick ticks at the end of a leg. */
export function arrowHead(from: Pt, tip: Pt, r: () => number): string {
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x)
  const len = 11
  const w = 0.48
  return [
    stroke(tip, { x: tip.x - len * Math.cos(ang - w), y: tip.y - len * Math.sin(ang - w) }, r, 0.5),
    stroke(tip, { x: tip.x - len * Math.cos(ang + w), y: tip.y - len * Math.sin(ang + w) }, r, 0.5),
  ].join(' ')
}
