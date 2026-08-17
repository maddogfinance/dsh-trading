/**
 * Browser half: claims the keyed `tool.call.toolview` slot for the two
 * tool-market tools whose results carry a chart payload. Keys are wire tool
 * names; an unclaimed key falls back to dsh's generic card, so hosts without
 * this package lose nothing.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { ChartCard } from './ChartCard.js'

// The ecosystem seam: third-party dsh client plugins require
// '@dsh-trading/client-chart/client' (mark it external in your bundle — the
// dsh module loader resolves rostered plugin bundles by package name) and
// register PURE renderers for annotation types this card has never heard of.
export { registerAnnotationRenderer } from './ChartCard.js'
export type { AnnotationRenderer, AnnotationRendererContext, DrawPrimitive } from './ChartCard.js'
export type { ChartAnnotation, ChartPayload, ChartScenario, ChartTimeframeData } from './payload.js'

export const name = 'client-chart'
export const inject = ['slots']

const CHART_TOOLS = ['market_snapshot', 'get_ohlcv', 'annotate_chart']

export function apply(ctx: ClientContext): void {
  // register() throws on undeclared slots — inject() waits for dsh-client-ui-tool
  // to declare 'tool.call.toolview' and re-runs across HMR redeclarations.
  ctx.slots.inject('tool.call.toolview', () => CHART_TOOLS.map(key =>
    ctx.slots.register(
      { name: 'tool.call.toolview', key, registrant: '@dsh-trading/client-chart' },
      ChartCard,
    )))
}
