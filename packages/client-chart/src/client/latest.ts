/**
 * The lift seam: a one-slot store holding the most recent chart payload any
 * card rendered, so the trading frame's persistent column can mirror it.
 *
 * Deliberately a module-level store rather than conversation state. The panel
 * must not reach into the chat's data model — that would couple presentation
 * to the conversation implementation and break the moment dsh reshapes it.
 * What the panel actually wants is narrower and more honest: *the chart the
 * user last saw*. A card that renders publishes; the panel subscribes. Nothing
 * in between.
 *
 * Consequences worth knowing: the value does not survive a page reload (there
 * is no durable store here and the payload is re-derived from the transcript
 * on re-render anyway), and scrolling an old card back into view republishes
 * it — which is the intended reading of "last seen", not a bug.
 */
import type { ChartPayload } from './payload.js'

type Listener = () => void

let latest: ChartPayload | null = null
const listeners = new Set<Listener>()

/**
 * Publish a payload as the newest chart. No-op when the payload is already the
 * current one, so a re-render storm does not wake every subscriber.
 * @param payload - the payload the publishing card just rendered.
 */
export function publishLatestChart(payload: ChartPayload): void {
  if (latest === payload) return
  latest = payload
  for (const listener of listeners) listener()
}

/**
 * Subscribe to payload changes (the `useSyncExternalStore` subscribe half).
 * @param listener - called after each change.
 * @returns unsubscribe.
 */
export function subscribeLatestChart(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Read the current payload (the `useSyncExternalStore` snapshot half).
 * Returns a stable reference between publishes, as that hook requires.
 * @returns the newest payload, or null before any card has rendered.
 */
export function getLatestChart(): ChartPayload | null {
  return latest
}

/*
 * Whether the trading frame's chart column is on screen. Cards in the chat
 * read it: with the column open the chart lives there, so a data read
 * collapses to a one-line receipt instead of a second copy of the chart.
 */
let columnOpen = false
const columnListeners = new Set<Listener>()

/** The chart column reports whether it is open (width above zero). */
export function setColumnOpen(open: boolean): void {
  if (columnOpen === open) return
  columnOpen = open
  for (const listener of columnListeners) listener()
}

export function subscribeColumn(listener: Listener): () => void {
  columnListeners.add(listener)
  return () => {
    columnListeners.delete(listener)
  }
}

export function getColumnOpen(): boolean {
  return columnOpen
}
