/**
 * The trading shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * details), the drag handles (pointer capture + rAF throttle), the concession
 * chain (columns.ts), and the child-slot render decisions.
 *
 * Step 1 deliberately renders the SAME three columns as dsh's stock AppFrame:
 * the point of this stage is to prove the row swap is sound — that ui-sidebar
 * and ui-conversation mount unchanged into seats a third-party frame declares
 * — before any trading-specific column is added.
 *
 * Pure component: everything arrives through the framework shares — zero
 * cordis imports, zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slots.js'
import { computeColumns, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT } from './columns.js'
import { styles } from './styles.js'
import type { createLayoutStore } from './stores.js'

/** Full composed props: runtime share + child-slot render share + store share. */
export type TradingFrameProps = PropsRuntime<'root'> &
  PropsRenderSlots<'sidebar' | 'trading.chart' | 'conversation' | 'details' | 'shell.overlay'> &
  PropsStore<ReturnType<typeof createLayoutStore>>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children: ReactNode }) {
  return <div className={styles.centerCol}>{props.children}</div>
}

/** Chart column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function ChartColumn(props: { children: ReactNode }) {
  return <div className={styles.chartCol}>{props.children}</div>
}

/**
 * Shown when no plugin has claimed the chart seat — an explained empty column
 * beats a dead gutter, and it names the seat so the fix is discoverable.
 */
function ChartPlaceholder() {
  return (
    <div className={styles.chartEmpty}>
      <p>No chart plugin has claimed this column.</p>
      <p className={styles.chartEmptyHint}>
        Register a component into the <code>trading.chart</code> slot to fill it.
      </p>
    </div>
  )
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children: ReactNode }) {
  return <div className={styles.detailsCol}>{props.children}</div>
}

/** One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin. */
function DragHandle(props: {
  side: 'sidebar' | 'chart' | 'details'
  left: number
  onStart: () => void
  onDrag: (dx: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current)
      frame.current = null
    }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={styles.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The three-column frame (see module doc). */
export function TradingFrame({ useStore, useSessions, actions, renderSlot }: TradingFrameProps) {
  const panels = useStore((s) => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })

  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const lastSession = useRef(detailsSession)

  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) actions.closeDetails()
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's width straight off the observer entry.
  //
  // NOT through requestAnimationFrame: rAF does not run at all while the
  // document reports hidden, and embedding surfaces (an in-app browser pane, a
  // tab restored in the background) report hidden while the user is looking
  // right at them. Deferring the solve to rAF leaves the whole layout frozen
  // at whatever `window.innerWidth` happened to be at mount — zero, in a pane
  // that had not been sized yet — so the chart column never opens and no
  // resize can rescue it. ResizeObserver already delivers at most once per
  // layout, and React batches the state update, so the throttle bought
  // nothing that was worth this.
  useEffect(() => {
    const el = frameRef.current
    if (el === null) return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? el.getBoundingClientRect().width
      if (width > 0) setViewport(prev => prev === width ? prev : width)
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
    }
  }, [])

  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => {
    actions.setNarrow(narrow)
  }, [actions, narrow])

  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const cols = computeColumns(
    viewport,
    sidebarCollapsed ? 0 : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar,
    panels.chart,
    detailsSession === undefined ? 0 : panels.details,
  )
  const colsRef = useRef(cols)
  colsRef.current = cols

  const sidebarBase = useRef(0)
  const chartBase = useRef(0)
  const detailsBase = useRef(0)
  const [dragging, setDragging] = useState(false)

  const onDragEnd = useCallback(() => {
    setDragging(false)
  }, [])
  const onSidebarStart = useCallback(() => {
    sidebarBase.current = colsRef.current.sidebar
    setDragging(true)
  }, [])
  const onChartStart = useCallback(() => {
    chartBase.current = colsRef.current.chart
    setDragging(true)
  }, [])
  const onDetailsStart = useCallback(() => {
    detailsBase.current = colsRef.current.details
    setDragging(true)
  }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  // The chart preference is a ratio, so a drag has to be re-expressed against
  // the room the two flexible columns share — otherwise the split would jump
  // on the next window resize.
  const onChartDrag = useCallback((dx: number) => {
    const cols = colsRef.current
    const room = cols.chart + cols.center
    if (room > 0) actions.setChart((chartBase.current + dx) / room)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])

  return (
    <div
      ref={frameRef}
      className={styles.frame}
      style={{
        gridTemplateColumns: `${cols.sidebar}px ${cols.chart}px minmax(0, 1fr) ${cols.details}px`,
      }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-chart-collapsed={cols.chart === 0 || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-dragging={dragging || undefined}
    >
      <div className={styles.sidebarCol}>
        {renderSlot('sidebar', { collapsed: sidebarCollapsed, width: cols.sidebar })}
      </div>
      <ChartColumn>
        {renderSlot('trading.chart', { width: cols.chart }, { fallback: <ChartPlaceholder /> })}
      </ChartColumn>
      <>
        <CenterColumn>{renderSlot('conversation', {})}</CenterColumn>
        <DetailsColumn>{renderSlot('details', {})}</DetailsColumn>
      </>
      <div className={styles.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {!sidebarCollapsed && (
        <DragHandle
          side="sidebar"
          left={cols.sidebar}
          onStart={onSidebarStart}
          onDrag={onSidebarDrag}
          onEnd={onDragEnd}
        />
      )}
      {cols.chart > 0 && (
        <DragHandle
          side="chart"
          left={cols.sidebar + cols.chart}
          onStart={onChartStart}
          onDrag={onChartDrag}
          onEnd={onDragEnd}
        />
      )}
      {cols.details > 0 && (
        <DragHandle
          side="details"
          left={viewport - cols.details}
          onStart={onDetailsStart}
          onDrag={onDetailsDrag}
          onEnd={onDragEnd}
        />
      )}
    </div>
  )
}
