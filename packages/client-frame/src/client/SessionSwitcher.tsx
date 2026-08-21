/**
 * Session switcher for the conversation header.
 *
 * This frame collapses the sidebar to its rail by default, because a permanent
 * session-history column is a poor trade against chart width. That decision
 * owes the user a replacement route to their sessions, and this is it: a
 * control in the conversation's own top-right, where the thing it switches
 * actually lives.
 *
 * Reads the session list through the framework's standard `useSessions` feed
 * and switches through the injected `open` — no cordis import, no subscription
 * of its own.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { styles } from './styles.js'

/** The one verb this control needs from `ctx.sessions`. */
export interface SessionSwitcherInject {
  open(id: string): void
}

/** Rows the switcher lists; a structural subset of the runtime's SessionSummary. */
interface SessionRow {
  id: string
  displayTitle: string
}

/** The standard-kit session feed, narrowed to what this control reads. */
interface SessionsSnapshot {
  ids: string[]
  byId: Record<string, { displayTitle?: string } | undefined>
  current: string | undefined
}

/** Props: the framework's session feed plus the injected switch verb. */
export interface SessionSwitcherProps extends SessionSwitcherInject {
  useSessions: <T>(select: (snapshot: SessionsSnapshot) => T) => T
}

/** How many recent sessions the menu lists before it stops being a menu. */
const MAX_ROWS = 12

const MENU: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  zIndex: 40,
  minWidth: 240,
  maxWidth: 340,
  maxHeight: 380,
  overflowY: 'auto',
  padding: 4,
  borderRadius: 8,
  border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))',
  background: 'var(--dsw-alias-bg-float, var(--dsw-alias-bg-base, #1e1e1e))',
  boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
}

/**
 * The header control.
 * @param useSessions - framework session feed.
 * @param open - switch to a session by id.
 * @returns the trigger button and, while open, the session menu.
 */
export function SessionSwitcher({ useSessions, open }: SessionSwitcherProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  const rows = useSessions((snapshot): SessionRow[] =>
    snapshot.ids.slice(0, MAX_ROWS).map(id => ({
      id,
      displayTitle: snapshot.byId[id]?.displayTitle ?? id,
    })))
  const current = useSessions(snapshot => snapshot.current)

  // Dismiss on outside click and on Escape: a menu that can only be closed by
  // picking something is a trap, and this one sits over the chart.
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      if (root.current !== null && !root.current.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  const pick = useCallback((id: string) => {
    setMenuOpen(false)
    if (id !== current) open(id)
  }, [current, open])

  return (
    <div ref={root} className={styles.switcher}>
      <button
        type="button"
        className={styles.switcherTrigger}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen(v => !v)}
        title="Switch session"
      >
        Sessions
      </button>
      {menuOpen
        ? (
          <div style={MENU} role="menu">
            {rows.length === 0
              ? <div className={styles.switcherEmpty}>No other sessions yet.</div>
              : rows.map(row => (
                <button
                  key={row.id}
                  type="button"
                  role="menuitem"
                  className={styles.switcherItem}
                  data-current={row.id === current || undefined}
                  onClick={() => pick(row.id)}
                >
                  {row.displayTitle}
                </button>
              ))}
          </div>
        )
        : null}
    </div>
  )
}
