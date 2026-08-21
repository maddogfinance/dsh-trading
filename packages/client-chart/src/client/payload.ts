/**
 * The card's copy of the chart-payload contract, validated defensively at the
 * trust boundary: `block.meta` is whatever some tool wrote into the session
 * log, possibly by an older or newer @dsh-trading/tool-market than this card.
 * Producer lives at packages/tool-market/src/chart-payload.ts.
 */

export type ChartCandle = {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Kept deliberately open: `type` routes to the renderer registry, so ecosystem
 * plugins can ship annotation kinds this card has never heard of.
 */
export type ChartAnnotation = { type: string } & Record<string, unknown>

export type ChartScenario = {
  direction: 'bull' | 'bear'
  stance: 'base' | 'alternative'
  thesis: string
  trigger: string
  invalidation: string
  triggerPrice?: number
  invalidationPrice?: number
}

export type ChartTimeframeData = {
  timeframe: string
  candles: ChartCandle[]
  /** RegimeSnapshot from the producer, kept loose so new indicators never break the card. */
  indicators: Record<string, unknown> | null
  series?: Record<string, (number | null)[]>
  annotations?: ChartAnnotation[]
}

export type ChartPayload = {
  kind: 'chart'
  version: 1
  provider: string
  symbol: string
  timeframes: ChartTimeframeData[]
  scenarios?: ChartScenario[]
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isCandle(x: unknown): x is ChartCandle {
  return isRecord(x)
    && typeof x['time'] === 'string'
    && Number.isFinite(x['open']) && Number.isFinite(x['high'])
    && Number.isFinite(x['low']) && Number.isFinite(x['close'])
    && Number.isFinite(x['volume'])
}

function readTimeframe(x: unknown): ChartTimeframeData | null {
  if (!isRecord(x) || typeof x['timeframe'] !== 'string' || !Array.isArray(x['candles'])) return null
  if (!x['candles'].every(isCandle)) return null
  if (x['candles'].length === 0) return null
  const indicators = isRecord(x['indicators']) ? x['indicators'] : null
  const series = isRecord(x['series']) ? x['series'] as ChartTimeframeData['series'] : undefined
  const annotations = Array.isArray(x['annotations'])
    ? x['annotations'].filter((a): a is ChartAnnotation => isRecord(a) && typeof a['type'] === 'string')
    : undefined
  return {
    timeframe: x['timeframe'],
    candles: x['candles'],
    indicators,
    ...series !== undefined ? { series } : {},
    ...annotations !== undefined && annotations.length > 0 ? { annotations } : {},
  }
}

function readScenario(x: unknown): ChartScenario | null {
  if (!isRecord(x)) return null
  if (x['direction'] !== 'bull' && x['direction'] !== 'bear') return null
  if (x['stance'] !== 'base' && x['stance'] !== 'alternative') return null
  if (typeof x['thesis'] !== 'string' || typeof x['trigger'] !== 'string' || typeof x['invalidation'] !== 'string') return null
  const triggerPrice = typeof x['triggerPrice'] === 'number' && Number.isFinite(x['triggerPrice'])
    ? x['triggerPrice']
    : undefined
  const invalidationPrice = typeof x['invalidationPrice'] === 'number' && Number.isFinite(x['invalidationPrice'])
    ? x['invalidationPrice']
    : undefined
  return {
    direction: x['direction'],
    stance: x['stance'],
    thesis: x['thesis'],
    trigger: x['trigger'],
    invalidation: x['invalidation'],
    ...triggerPrice !== undefined ? { triggerPrice } : {},
    ...invalidationPrice !== undefined ? { invalidationPrice } : {},
  }
}

/** Null when meta is absent, foreign, from a different payload version, or malformed. */
export function readChartPayload(meta: unknown): ChartPayload | null {
  if (!isRecord(meta) || meta['kind'] !== 'chart' || meta['version'] !== 1) return null
  if (typeof meta['provider'] !== 'string' || typeof meta['symbol'] !== 'string') return null
  if (!Array.isArray(meta['timeframes'])) return null
  const timeframes = meta['timeframes'].map(readTimeframe).filter((t): t is ChartTimeframeData => t !== null)
  if (timeframes.length === 0) return null
  const scenarios = Array.isArray(meta['scenarios'])
    ? meta['scenarios'].map(readScenario).filter((s): s is ChartScenario => s !== null)
    : undefined
  return {
    kind: 'chart',
    version: 1,
    provider: meta['provider'],
    symbol: meta['symbol'],
    timeframes,
    ...scenarios !== undefined && scenarios.length > 0 ? { scenarios } : {},
  }
}

/** Flatten the model-facing content blocks to text, for the no-meta fallback. */
export function contentText(content: unknown, depth = 0): string {
  if (depth > 3 || !Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block['type'] === 'text' && typeof block['text'] === 'string') parts.push(block['text'])
    else if ('content' in block) {
      const nested = contentText(block['content'], depth + 1)
      if (nested !== '') parts.push(nested)
    }
  }
  return parts.join('\n')
}

/**
 * Content identity of a chart's marks — what "the drawing changed" means.
 *
 * The card keys its overlay-drawing effect on this. Keying on annotation TYPES
 * instead (what it used to do) collides on the commonest edit there is:
 * replacing three levels with three different levels leaves the type list
 * byte-identical, so the canvas keeps the old prices while the table below it
 * prints the new ones. Invisible in a chat bubble that mounts fresh each time;
 * permanent in a persistent column that receives annotate_chart repeatedly.
 *
 * Order-sensitive on purpose: a reorder counts as a change and costs one extra
 * rebuild, which is the cheap side of this trade.
 *
 * @param annotations - the timeframe's annotations.
 * @param scenarios - the payload's scenarios.
 * @returns a string that differs whenever anything drawable differs.
 */
export function annotationDigest(
  annotations: readonly ChartAnnotation[] | undefined,
  scenarios: readonly ChartScenario[] | undefined,
): string {
  return JSON.stringify([annotations ?? [], scenarios ?? []])
}
