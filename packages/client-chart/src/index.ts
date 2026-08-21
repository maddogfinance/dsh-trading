/**
 * Host half of the chart-card package. Two jobs, both small:
 *
 *  1. Give the profile's Loader row a plugin to mount, so the dsh web host
 *     scans the package's `dsh.client` manifest and serves the browser bundle.
 *  2. Publish a loopback RPC channel the persistent chart column reads from,
 *     so the user can put a symbol on the chart WITHOUT going through the
 *     model. See ./market-rpc.ts for why that matters.
 *
 * Under a headless profile there is no `connection` service; the row then does
 * nothing at all rather than failing to load — the channel is a web affordance,
 * not a capability the rest of the bundle depends on.
 * @module @dsh-trading/client-chart
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandler, HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ChartView, MarketDataLike } from './market-rpc.js'
import { describeChartView, MARKET_CHANNEL, serveMarketEndpoint } from './market-rpc.js'

export {
  describeChartView,
  ENDPOINTS,
  MARKET_CHANNEL,
  MAX_PANEL_BARS,
  readChartView,
  readOhlcvRequest,
  serveMarketEndpoint,
} from './market-rpc.js'
export type { ChartView, MarketDataLike, OhlcvRequest, OhlcvResponse, SymbolsResponse } from './market-rpc.js'

export const name = 'client-chart'

/**
 * No top-level `inject`. `connection` is web-only, so declaring it as a hard
 * dependency would leave this row PENDING forever under a headless profile —
 * and a pending entry fails the whole boot. The runtime `ctx.inject` below
 * waits for both services instead: the row activates immediately, and the
 * channel appears if and when the web transport and a provider are mounted.
 */

/**
 * How long a published view stays believable.
 *
 * The store is one slot, and any browser on the loopback can write it — a
 * second tab left open on another symbol will clobber the one the user is
 * actually reading, and the model will then state the wrong instrument with
 * complete confidence. Neither read site (prompt assembly, tool execution)
 * carries a session id to key on, so freshness stands in for identity: a
 * panel that is genuinely being watched republishes on a heartbeat, and an
 * abandoned tab's claim simply expires. Saying nothing beats saying the wrong
 * symbol.
 */
const VIEW_TTL_MS = 30_000

export function apply(ctx: Context): void {
  // What the browser panel last reported it was showing, and when.
  let view: ChartView | undefined
  let viewAt = 0

  /** The view, if a panel is still actively reporting it. */
  const liveView = (): ChartView | undefined =>
    view !== undefined && Date.now() - viewAt <= VIEW_TTL_MS ? view : undefined

  const makeHandler = (marketData: MarketDataLike): ConnectionRpcHandler => async (endpoint, payload) => {
    try {
      return {
        ok: true,
        value: await serveMarketEndpoint(marketData, endpoint, payload, next => {
          view = next
          viewAt = Date.now()
        }),
      }
    } catch (error) {
      // The panel shows this text verbatim, so it must read as guidance:
      // provider errors already name the symbol, the timeframe, or the OpenD
      // fix. Folding it into the error branch keeps the transport honest — a
      // failed lookup is not an empty chart.
      return {
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
      }
    }
  }

  // The agent sits next to this chart but cannot see it: the panel's data path
  // deliberately bypasses the tool layer, so nothing about it reaches the
  // model on its own. Without this it asks the user for a screenshot of a
  // chart it is rendering. One line of context per turn fixes that; the tool
  // below carries the same facts for a model that wants them explicitly.
  ctx.inject(['systemPrompt'], scoped => {
    scoped.effect(() => scoped.systemPrompt.context({
      name: 'dsh-trading:chart-panel',
      order: 50,
      // Evaluated per assembly. Empty while no chart is up, and the prompt
      // layer treats empty text as no contribution — an idle panel is free.
      text: () => describeChartView(liveView()),
    }))
  })

  ctx.inject(['tools'], scoped => {
    scoped.effect(() => scoped.tools.register(defineTool({
      name: 'get_chart_view',
      description:
        "Read what the user's chart panel is currently displaying: symbol, timeframe, "
        + 'bar count, visible time span, last price, and whether it is refreshing live. '
        + 'Read-only. Use this instead of asking the user to describe or screenshot their chart.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            open: { type: 'boolean', required: true },
            symbol: { type: 'string' },
            timeframe: { type: 'string' },
            bars: { type: 'number' },
            from: { type: 'string' },
            to: { type: 'string' },
            close: { type: 'number' },
            live: { type: 'boolean' },
            origin: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.open
            ? `${value.symbol} @ ${value.timeframe} — ${value.bars} bars`
              + `${value.from !== undefined ? `, ${value.from} to ${value.to}` : ''}`
              + `${value.close !== undefined ? `, last ${value.close}` : ''}`
              + `, ${value.live === true ? 'live' : 'paused'} (${value.origin})`
            : 'The chart panel is empty — the user has not opened a chart.',
        }],
      },
      isConcurrencySafe: () => true,
      async execute() {
        const current = liveView()
        if (current === undefined) return { open: false }
        // Spread the optional fields conditionally: `exactOptionalPropertyTypes`
        // distinguishes "absent" from "present and undefined", and the tool
        // output schema wants the former.
        return {
          open: true,
          symbol: current.symbol,
          timeframe: current.timeframe,
          bars: current.bars,
          live: current.live,
          origin: current.origin,
          ...current.from !== undefined ? { from: current.from } : {},
          ...current.to !== undefined ? { to: current.to } : {},
          ...current.close !== undefined ? { close: current.close } : {},
        }
      },
      presentCall: args => ({ card: 'generic', title: 'Read chart panel', kind: 'read', rawInput: args }),
    })))
  })

  ctx.inject(['connection', 'marketData'], scoped => {
    // Typed at the read rather than through declaration merging: this package
    // compiles with `types: []`, so the ambient `ctx.connection` augmentation
    // is not necessarily in scope here.
    const connection = scoped.get('connection') as HostConnectionHandle
    const marketData = scoped.get('marketData') as MarketDataLike

    scoped.effect(() => {
      const dispose = connection.rpc.handle(MARKET_CHANNEL, makeHandler(marketData), { authority: 'loopback' })
      return () => {
        void dispose()
      }
    }, 'client-chart: market data channel')
  })
}
