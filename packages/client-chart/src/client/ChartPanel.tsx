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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import type { ChartOwnerProps } from '@dsh-trading/client-frame/client'
import { ChartBody } from './ChartCard.js'
import { getLatestChart, subscribeLatestChart } from './latest.js'
import { decideFollow } from './follow.js'
import { mergeMarks, mergeTail, readMarks, withCandles } from './market-client.js'
import type { ChartMarks, MarketClient } from './market-client.js'
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

/** Settle time before following the conversation, so a burst of calls costs one fetch. */
const FOLLOW_SETTLE_MS = 400

/** Consecutive failed refreshes before the badge stops claiming the chart is live. */
const STALL_AFTER = 3

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
  const [marks, setMarks] = useState<ChartMarks | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [pinned, setPinned] = useState(false)
  const [stalled, setStalled] = useState(false)
  const followTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inflight = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const quiet = useRef(0)
  const fails = useRef(0)
  const failedFollow = useRef<string | null>(null)
  const ownOrigin = useRef<'user' | 'followed'>('user')

  // Adopt whatever the agent last DREW, separately from what it last fetched.
  // Keyed on content, not identity: `latest` republishes the same payload
  // whenever an old card scrolls back into view, and an identical republish
  // must not disturb the chart or re-arm a dismissal.
  useEffect(() => {
    const next = readMarks(fromAgent)
    if (next === null) return
    setMarks(cur => {
      if (cur !== null && cur.key === next.key) return cur
      // A dismissal is about the marks that were on screen when it was
      // clicked, not a standing veto. Without this, adopting a different set
      // while an old key is dismissed hides the pill too — and with the pill
      // goes the only way back to the drawing.
      setDismissed(null)
      return next
    })
  }, [fromAgent])

  const active = marks !== null && marks.key !== dismissed ? marks : null
  const merged = useMemo(
    () => own !== null && active !== null ? mergeMarks(own, active) : null,
    [own, active],
  )

  // The panel's own lookup takes precedence: an agent answer arriving mid-read
  // must not replace what the user deliberately put on screen. Its DRAWINGS
  // are welcome on top of it, which is what `merged` carries; when they are
  // about a different chart, mergeMarks hands the payload straight back.
  const payload = merged?.payload ?? own ?? fromAgent

  const load = useCallback(async (symbol: string, tf: string, trigger: 'user' | 'follow' = 'user') => {
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    setBusy(true)
    if (trigger === 'user') setError(null)
    failedFollow.current = null
    // A deliberate lookup is a fresh start for the live loop: the quiet streak
    // belongs to the series that earned it, so carrying it across a symbol or
    // timeframe change would leave a moving instrument stuck at the idle
    // cadence it inherited from a closed one.
    quiet.current = 0
    try {
      const next = await market.getPayload(symbol, tf, controller.signal)
      if (!controller.signal.aborted) {
        setOwn(next)
        ownOrigin.current = trigger === 'user' ? 'user' : 'followed'
        // Always clear a stale error on success, whoever asked. `error`
        // outranks the chart in the render ladder, so leaving one set would
        // hide the chart a followed load just put on screen — with no control
        // anywhere to dismiss it.
        setError(null)
        fails.current = 0
        setStalled(false)
      }
    } catch (cause) {
      // A followed load leaves whatever is on screen alone: `error` outranks
      // the chart in the render ladder, so a transient failure would replace a
      // good chart with red text nobody asked for.
      if (!controller.signal.aborted) {
        if (trigger === 'user') setError(cause instanceof Error ? cause.message : String(cause))
        // Remember a target the conversation asked for and the provider
        // refused. The follow effect re-runs on every `own` identity change —
        // and the live tail mints one per price tick — so without this the
        // panel refetches the same failing symbol for as long as the tape
        // moves, silently, forever.
        else failedFollow.current = `${symbol}|${tf}`
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }, [market])

  // Follow the conversation. The agent's payload is a frozen <=200-bar
  // snapshot and the live loop only runs on a series the panel fetched itself,
  // so adopting it verbatim gives a chart that never moves — the reported
  // symptom. Instead the panel loads that instrument and interval as ITS OWN
  // series: live, full depth, and the marks then match by construction.
  //
  // Debounced because an analysis can call annotate_chart dozens of times in
  // one turn; only the settled target is worth a fetch.
  useEffect(() => {
    const decision = decideFollow(
      fromAgent === null
        ? null
        : { symbol: fromAgent.symbol, timeframe: fromAgent.timeframes[0]?.timeframe },
      {
        width,
        pinned,
        own: own === null ? null : { symbol: own.symbol, timeframe: own.timeframes[0]?.timeframe },
      },
    )
    if (decision.action !== 'load') return
    if (failedFollow.current === `${decision.symbol}|${decision.timeframe}`) return

    clearTimeout(followTimer.current)
    followTimer.current = setTimeout(() => {
      setTimeframe(decision.timeframe)
      void load(decision.symbol, decision.timeframe, 'follow')
    }, FOLLOW_SETTLE_MS)
    return () => clearTimeout(followTimer.current)
  }, [fromAgent, own, pinned, width, load])

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

  // Mirror the instrument on screen into the input, so the box is never empty
  // under a chart and a submit means "reload what I am looking at". Skipped
  // while the field has focus — the user's half-typed symbol outranks this.
  const shownRef = useRef<string | null>(null)
  useEffect(() => {
    const shown = payload?.symbol?.trim() ?? ''
    if (shown === '' || shown === shownRef.current) return
    // Record only what was actually mirrored. Marking a symbol as done while
    // the field had focus left the box stuck on the previous instrument for
    // good, because the guard above then short-circuits every later run.
    if (document.activeElement === inputRef.current) return
    shownRef.current = shown
    setDraft(shown)
  }, [payload])

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
        // Effective liveness, not the toggle: a stalled column is not
        // refreshing, and saying otherwise makes the model vouch for a frozen
        // chart's freshness.
        live: live && !stalled,
        origin: own === null ? 'agent' : ownOrigin.current === 'user' ? 'user' : 'followed',
        // Whether the agent's drawings actually landed is the one thing it
        // cannot infer: annotate_chart returning successfully says nothing
        // about what this column decided to render.
        ...merged?.applied === true && merged.kept > 0
          ? {
              marks: merged.kept,
              marksDropped: merged.dropped,
              ...active !== null ? { marksTimeframe: active.timeframe } : {},
            }
          : {},
      })
    }
    publish()
    const beat = setInterval(publish, VIEW_HEARTBEAT_MS)
    return () => clearInterval(beat)
  }, [payload, width, live, own, market, merged, active])

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
        // A refresh that succeeded is the end of a stall, whether or not the
        // bars moved: on a closed tape every poll returns the same series, and
        // clearing only on movement latched the warning on for the session.
        // Also keeps setStalled out of the updater below — React invokes those
        // during render, twice under StrictMode.
        fails.current = 0
        setStalled(false)
        setOwn(current => {
          if (current === null) return current
          const series = current.timeframes[0]?.candles ?? []
          const nextSeries = mergeTail(series, tail)
          if (nextSeries === series) {
            quiet.current += 1
            return current
          }
          quiet.current = 0
          setTick(new Date().toLocaleTimeString())
          return withCandles(current, nextSeries)
        })
      } catch {
        // A transient hiccup must not kill the loop or replace a good chart
        // with an error — but a SUSTAINED one must not keep claiming "Live"
        // over a frozen chart either. That combination is what makes a dead
        // transport look like a broken feature.
        quiet.current += 1
        fails.current += 1
        if (fails.current >= STALL_AFTER) setStalled(true)
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

  // What the toolbar describes is what is ON SCREEN — which is not always what
  // the user typed. A chart the agent produced arrives with `own` null and the
  // input still empty, and reading the controls off `draft` alone left the
  // timeframe buttons inert (no symbol to reload) while highlighting a period
  // the chart was not even drawn on.
  const shownSymbol = (payload?.symbol ?? '').trim()
  const shownTimeframe = payload?.timeframes[0]?.timeframe
  // A period the user just clicked wins until its data lands. Reading the
  // highlight off the payload alone meant a click gave no feedback while the
  // fetch was in flight, and was silently discarded if the fetch failed — the
  // next submit would then use a period the toolbar was no longer showing.
  const activeTimeframe = busy || error !== null ? timeframe : shownTimeframe ?? timeframe

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    const symbol = draft.trim()
    if (symbol === '') return
    setPinned(true)
    void load(symbol, activeTimeframe)
  }

  const pickTimeframe = (tf: string): void => {
    setPinned(true)
    setTimeframe(tf)
    // Prefer the symbol on screen over the draft: switching the period of a
    // chart the agent put up is the commonest reason to touch these buttons.
    const symbol = (draft.trim() !== '' ? draft : shownSymbol).trim()
    if (symbol !== '') void load(symbol, tf)
  }

  // The agent's drawings, and what to do about them. Suppressed while the body
  // is showing a loading or error screen: `own` survives a failed lookup, so a
  // pill there would claim marks over an error message.
  const showPill = active !== null && own !== null && error === null && !(busy && payload === null)
  // Scenarios draw their own trigger/invalidation lines, so a scenario-only
  // analysis is not "0 marks".
  const markCount = active === null ? 0 : active.annotations.length + active.scenarios.length
  const offerable = active !== null
    && TIMEFRAMES.includes(active.timeframe as (typeof TIMEFRAMES)[number])
    && own?.provider === active.provider
  const marksPill = !showPill || active === null ? null : (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {merged?.applied === true
        ? (
          <span
            style={{ ...TF_BUTTON(true), cursor: 'default' }}
            title={
              `Drawn by the agent's annotate_chart on the ${active.timeframe} analysis.`
              + (merged.dropped > 0
                ? ` ${merged.dropped} fell outside this window's price range or bar span and are not shown.`
                : '')
            }
          >
            ✎ {merged.kept} marks · {active.timeframe} · {active.at}
            {merged.dropped > 0 ? ` · ${merged.dropped} off-window` : ''}
          </span>
        )
        : offerable
          ? (
            <button
              type="button"
              style={TF_BUTTON(false)}
              title={`The agent drew on ${active.rawSymbol} ${active.timeframe}. Load that chart here to see the marks.`}
              onClick={() => {
                // Taking the agent's marked-up chart IS the user taking the
                // wheel — same as submitting a symbol or picking a period.
                // Left unpinned, the follow effect drags the column back to
                // whatever the conversation last charted 400ms later, so the
                // button could never actually land anywhere.
                setPinned(true)
                setDraft(active.rawSymbol)
                setTimeframe(active.timeframe)
                void load(active.rawSymbol, active.timeframe)
              }}
            >
              ✎ {active.rawSymbol} {active.timeframe} · {markCount} marks — Show
            </button>
          )
          : (
            <span
              style={{ ...TF_BUTTON(false), cursor: 'default' }}
              title={
                `The agent drew on ${active.rawSymbol} ${active.timeframe}, which this panel cannot load `
                + `(different provider, or a timeframe outside its picker).`
              }
            >
              ✎ {active.rawSymbol} {active.timeframe} · not on this chart
            </span>
          )}
      <button
        type="button"
        style={{ ...TF_BUTTON(false), padding: '2px 5px' }}
        title="Dismiss the agent's marks until it draws new ones"
        onClick={() => setDismissed(active.key)}
      >
        ×
      </button>
    </span>
  )

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <form style={BAR} onSubmit={submit}>
        <input
          ref={inputRef}
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
          <button key={tf} type="button" style={TF_BUTTON(tf === activeTimeframe)} onClick={() => pickTimeframe(tf)}>
            {tf}
          </button>
        ))}
        {pinned
          ? (
            <button
              type="button"
              style={TF_BUTTON(false)}
              title="This chart is pinned — the column stopped following the conversation. Click to follow again."
              onClick={() => setPinned(false)}
            >
              📌 Pinned
            </button>
          )
          : null}
        {marksPill}
        <button
          type="button"
          style={{ ...TF_BUTTON(live), marginLeft: 'auto' }}
          onClick={() => setLive(v => !v)}
          aria-pressed={live}
          title={
            !live ? 'Live updates paused'
              : stalled ? 'Refreshes are failing — the chart is not moving. Reload the page if this persists.'
                : 'Live updates on — click to pause'
          }
        >
          {!live ? '❙❙ Paused' : stalled ? '⚠ Stalled' : `● Live${tick !== null ? ` ${tick}` : ''}`}
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
              ? <ChartBody payload={payload} shell={PANEL_SHELL} fill prose={false} />
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
