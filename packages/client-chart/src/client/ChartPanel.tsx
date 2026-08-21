/**
 * The persistent chart column: the occupant of the trading frame's
 * `trading.chart` seat.
 *
 * It is driven from BOTH ends, which is the whole point:
 *
 *  - **The user** types a symbol and picks a timeframe. That goes straight to
 *    `ctx.marketData` over the host channel — no tool call, no model in the
 *    loop. A workbench whose only input is "hope the agent calls the right
 *    tool" is not a workbench.
 *  - **The model** produces `market_snapshot` / `annotate_chart` results, whose
 *    payloads the cards publish; the panel adopts the newest one so the chart
 *    the agent reasoned about stops scrolling away with the conversation.
 *
 * The user's own lookup wins while it is on screen — an agent answer must not
 * yank the chart out from under someone mid-read. "Follow the agent" is a
 * toggle, not a surprise.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import type { ChartOwnerProps } from '@dsh-trading/client-frame/client'
import { ChartBody } from './ChartCard.js'
import { getLatestChart, subscribeLatestChart } from './latest.js'
import { mergeTail, withCandles } from './market-client.js'
import type { MarketClient } from './market-client.js'
import type { ChartPayload } from './payload.js'

/** Timeframes the panel offers; the provider may serve a subset and will say so. */
const TIMEFRAMES = ['15m', '30m', '1h', '4h', '1d', '1w'] as const

/** Bars pulled per live refresh: the forming bar, plus a little overlap for a just-closed one. */
const TAIL_BARS = 3

/**
 * Live refresh cadence while the tape is moving.
 *
 * One second is affordable because the host answers from a warm series kept
 * current by Futu's own push — a refresh costs a local memory read, not a
 * broker request. Were this polling the broker per tick it would be both slow
 * and quota-hungry, which is exactly why the provider takes the push.
 */
const LIVE_MS = 1_000

/**
 * Cadence after the tape has gone quiet, or while the host reports the tab
 * unwatched. Kept close to the live cadence on purpose: a refresh is a local
 * memory read against a push-fed series, so backing off buys almost nothing
 * and costs responsiveness the moment the user looks back. This is a courtesy
 * to an idle machine, not a quota defence — the push already removed the quota
 * argument entirely.
 */
const IDLE_MS = 5_000

/** Unchanged polls before backing off. */
const QUIET_LIMIT = 8

/**
 * How often the panel re-asserts what it is showing, even when nothing changed.
 *
 * The host expires a view that stops being republished, which is how a tab
 * left open on another symbol stops speaking for the user. That only works if
 * a panel that IS being watched keeps saying so — including through a closed
 * market, when the payload never changes and the change-driven publication
 * would fall silent.
 */
const VIEW_HEARTBEAT_MS = 10_000

const PANEL_SHELL: CSSProperties = { padding: '10px 14px 14px', fontSize: 12, lineHeight: 1.5 }

const BAR: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '10px 14px',
  borderBottom: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))',
  flexWrap: 'wrap',
}

const INPUT: CSSProperties = {
  flex: '1 1 120px',
  minWidth: 0,
  background: 'var(--dsw-alias-bg-l1, transparent)',
  color: 'inherit',
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 12.5,
  fontFamily: 'inherit',
}

const TF_BUTTON = (on: boolean): CSSProperties => ({
  background: 'transparent',
  color: on ? 'var(--dsw-alias-text-1, inherit)' : 'var(--dsw-alias-text-3, rgba(128,128,128,0.9))',
  border: `1px solid ${on ? 'var(--dsw-alias-border-l3, rgba(128,128,128,0.6))' : 'transparent'}`,
  borderRadius: 5,
  padding: '2px 7px',
  fontSize: 11.5,
  cursor: 'pointer',
  fontWeight: on ? 600 : 400,
})

const NOTE: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', justifyContent: 'center',
  height: '100%', padding: '0 24px', textAlign: 'center', fontSize: 13,
  color: 'var(--dsw-alias-text-3, rgba(128, 128, 128, 0.9))',
}

/** What the plugin's inject face hands this component. */
export interface ChartPanelInject {
  market: MarketClient
}

/**
 * The chart column body.
 * @param width - resolved column width; 0 means the frame closed the column.
 *   The subtree stays MOUNTED at width 0 so state survives reopening, so the
 *   panel must decline to render — initialising a chart into a zero-width
 *   container burns a canvas nobody can see.
 * @param market - the host-backed data client.
 * @returns the chart, or an invitation to name a symbol.
 */
export function ChartPanel({ width, market }: ChartOwnerProps & ChartPanelInject): JSX.Element | null {
  const fromAgent = useSyncExternalStore(subscribeLatestChart, getLatestChart, getLatestChart)

  const [draft, setDraft] = useState('')
  const [timeframe, setTimeframe] = useState<string>('1d')
  const [own, setOwn] = useState<ChartPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [tick, setTick] = useState<string | null>(null)
  const inflight = useRef<AbortController | null>(null)
  const quiet = useRef(0)

  // The panel's own lookup takes precedence: an agent answer arriving mid-read
  // must not replace what the user deliberately put on screen.
  const payload = own ?? fromAgent

  const load = useCallback(async (symbol: string, tf: string) => {
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    setBusy(true)
    setError(null)
    // A deliberate lookup is a fresh start for the live loop: the quiet streak
    // belongs to the series that earned it, so carrying it across a symbol or
    // timeframe change would leave a moving instrument stuck at the idle
    // cadence it inherited from a closed one.
    quiet.current = 0
    try {
      const next = await market.getPayload(symbol, tf, controller.signal)
      if (!controller.signal.aborted) setOwn(next)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [market])

  // One symbols probe on mount, purely to tell the user what this provider
  // actually carries — a wrong-format symbol is the likeliest first mistake.
  useEffect(() => {
    let live = true
    market.listSymbols()
      .then(({ description, symbols }) => {
        if (!live) return
        const sample = symbols.slice(0, 4).map(s => s.symbol).join(' · ')
        setHint(symbols.length === 0 ? description : `${description} — e.g. ${sample}`)
      })
      .catch(() => { /* the input still works; the hint is a courtesy */ })
    return () => { live = false }
  }, [market])

  useEffect(() => () => inflight.current?.abort(), [])

  // Publish what is on screen. The panel's data path deliberately bypasses the
  // tool layer, which means nothing about this chart reaches the model on its
  // own — without this the agent asks the user to screenshot a chart it is
  // rendering two columns away.
  useEffect(() => {
    if (payload === null || width === 0) return
    const tf = payload.timeframes[0]
    if (tf === undefined) return
    const publish = (): void => {
      const candles = tf.candles
      const first = candles[0]
      const last = candles[candles.length - 1]
      market.publishView({
        symbol: payload.symbol,
        timeframe: tf.timeframe,
        bars: candles.length,
        from: first?.time,
        to: last?.time,
        close: last?.close,
        live,
        origin: own !== null ? 'user' : 'agent',
      })
    }
    publish()
    const beat = setInterval(publish, VIEW_HEARTBEAT_MS)
    return () => clearInterval(beat)
  }, [payload, width, live, own, market])

  // Live tail. Deliberately a poll rather than a push: the host channel is
  // unary, and a chart that is at most a few seconds stale is worth far less
  // engineering than a streaming transport. Only the last few bars move, so
  // each refresh is a few hundred bytes.
  //
  // Gated on the column being open. Tab visibility only SLOWS the loop, it
  // never stops it: embedding surfaces (an in-app browser pane, a background
  // preview) report `hidden` while the user is plainly looking at them, and a
  // liveness feature that silently dies on a host's misreport is worse than
  // one that occasionally polls a tab nobody is reading.
  useEffect(() => {
    if (!live || own === null || width === 0) return
    const symbol = own.symbol
    const tf = own.timeframes[0]?.timeframe
    if (tf === undefined) return

    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()

    const pump = async (): Promise<void> => {
      if (stopped) return
      try {
        const tail = await market.getTail(symbol, tf, TAIL_BARS, controller.signal)
        if (stopped) return
        setOwn(current => {
          if (current === null) return current
          const series = current.timeframes[0]?.candles ?? []
          const merged = mergeTail(series, tail)
          if (merged === series) {
            quiet.current += 1
            return current
          }
          quiet.current = 0
          setTick(new Date().toLocaleTimeString())
          return withCandles(current, merged)
        })
      } catch {
        // A transient provider hiccup must not kill the live loop or replace a
        // good chart with an error; the next tick simply tries again.
        quiet.current += 1
      }
      const quietly = quiet.current >= QUIET_LIMIT
      const unwatched = document.visibilityState !== 'visible'
      schedule(quietly || unwatched ? IDLE_MS : LIVE_MS)
    }

    function schedule(ms: number): void {
      if (!stopped) timer = setTimeout(() => void pump(), ms)
    }

    schedule(LIVE_MS)
    return () => {
      stopped = true
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [live, own, width, market])

  if (width === 0) return null

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const symbol = draft.trim()
    if (symbol !== '') void load(symbol, timeframe)
  }

  const pickTimeframe = (tf: string): void => {
    setTimeframe(tf)
    const symbol = (own?.symbol ?? draft).trim()
    if (symbol !== '') void load(symbol, tf)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <form style={BAR} onSubmit={submit}>
        <input
          style={INPUT}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Symbol — e.g. US.MU"
          aria-label="Chart symbol"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        {TIMEFRAMES.map(tf => (
          <button key={tf} type="button" style={TF_BUTTON(tf === timeframe)} onClick={() => pickTimeframe(tf)}>
            {tf}
          </button>
        ))}
        <button
          type="button"
          style={{ ...TF_BUTTON(live), marginLeft: 'auto' }}
          onClick={() => setLive(v => !v)}
          aria-pressed={live}
          title={live ? 'Live updates on — click to pause' : 'Live updates paused'}
        >
          {live ? `● Live${tick !== null ? ` ${tick}` : ''}` : '❙❙ Paused'}
        </button>
      </form>

      <div style={{ flex: 1, minHeight: 0 }}>
        {busy && payload === null
          ? <div style={NOTE}><p>Loading…</p></div>
          : error !== null
            ? (
              <div style={NOTE}>
                <p style={{ color: 'var(--dsw-alias-text-error, #e0563f)' }}>{error}</p>
                {hint !== null ? <p style={{ fontSize: 12, opacity: 0.75 }}>{hint}</p> : null}
              </div>
            )
            : payload !== null
              ? <ChartBody payload={payload} shell={PANEL_SHELL} fill />
              : (
                <div style={NOTE}>
                  <p>Type a symbol above, or ask the agent for one.</p>
                  {hint !== null ? <p style={{ fontSize: 12, opacity: 0.75 }}>{hint}</p> : null}
                </div>
              )}
      </div>
    </div>
  )
}
