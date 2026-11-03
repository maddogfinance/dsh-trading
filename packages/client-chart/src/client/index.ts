/**
 * Browser half: claims the keyed `tool.call.toolview` slot for the two
 * tool-market tools whose results carry a chart payload. Keys are wire tool
 * names; an unclaimed key falls back to dsh's generic card, so hosts without
 * this package lose nothing.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: brings the trading frame's `trading.chart` slot declaration into
// scope. Same pattern as the ui-tool dependency above — a slot contract, not a
// runtime import, so a profile without the frame still loads this plugin.
import type {} from '@dsh-trading/client-frame/client'
import { ChartCard } from './ChartCard.js'
import { ChartPanel } from './ChartPanel.js'
import { createMarketClient } from './market-client.js'
import { WalkthroughCard } from './WalkthroughCard.js'

// The ecosystem seam: third-party dsh client plugins require
// '@dsh-trading/client-chart/client' (mark it external in your bundle — the
// dsh module loader resolves rostered plugin bundles by package name) and
// register PURE renderers for annotation types this card has never heard of.
export { registerAnnotationRenderer } from './ChartCard.js'
export type { AnnotationRenderer, AnnotationRendererContext, DrawPrimitive } from './ChartCard.js'
export type { ChartAnnotation, ChartPayload, ChartScenario, ChartTimeframeData } from './payload.js'

export const name = 'client-chart'
export const inject = ['slots', 'connection']

const CHART_TOOLS = ['market_snapshot', 'get_ohlcv', 'annotate_chart']

/** The slice of `ctx.sessions` a reply needs: reach one session and send it a message. */
interface SessionsLike {
  scope(id: string): unknown
  sessionOf(scope: unknown): { prompt(content: { type: 'text'; text: string }[], mode: 'queue' | 'steer'): Promise<unknown> } | undefined
}

/**
 * Send the reader's tapped reply as their next message, exactly as if typed.
 * Looked up at click time rather than injected at apply: a profile without
 * the sessions service still loads this plugin, and the reply degrades to a
 * logged warning instead of a pending plugin row.
 */
function sendReply(ctx: ClientContext, sessionId: string, text: string): void {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  const scoped = sessions?.scope(sessionId)
  const session = scoped !== undefined ? sessions!.sessionOf(scoped) : undefined
  if (session === undefined) {
    console.warn('[client-chart] cannot reach the session to send a walkthrough reply')
    return
  }
  void session.prompt([{ type: 'text', text }], 'queue')
}

export function apply(ctx: ClientContext): void {
  // register() throws on undeclared slots — inject() waits for dsh-client-ui-tool
  // to declare 'tool.call.toolview' and re-runs across HMR redeclarations.
  ctx.slots.inject('tool.call.toolview', () => [
    ...CHART_TOOLS.map(key =>
      ctx.slots.register(
        { name: 'tool.call.toolview', key, registrant: '@dsh-trading/client-chart' },
        ChartCard,
      )),
    ctx.slots.register(
      {
        name: 'tool.call.toolview',
        key: 'walkthrough',
        registrant: '@dsh-trading/client-chart',
        inject: (sessionId: string) => ({ ask: (text: string) => sendReply(ctx, sessionId, text) }),
      },
      WalkthroughCard,
    ),
  ])

  // The persistent column, claimed the same way: inject() means a profile
  // running dsh's stock frame (no `trading.chart` declarer) simply never runs
  // this callback, and the cards above still work.
  //
  // The registration's `inject` face is how the panel reaches the host without
  // importing cordis: a slot component receives only framework props, so the
  // data client is bound here, in the one place that legitimately holds ctx.
  // `ctx.connection` is provided by dsh-client-connection; read it through
  // ctx.get so this package need not merge that plugin's Context augmentation
  // into a compilation that deliberately runs with `types: []`.
  const connection = ctx.get('connection') as ConnectionHandle
  const market = createMarketClient(connection.rpc)
  ctx.slots.inject('trading.chart', () => [
    ctx.slots.register(
      {
        name: 'trading.chart',
        registrant: '@dsh-trading/client-chart',
        inject: () => ({ market }),
      },
      ChartPanel,
    ),
  ])
}
