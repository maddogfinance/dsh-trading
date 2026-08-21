/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module cache (a de-facto
 * singleton surviving plugin reloads). register() receives the factory
 * (exclusive use: the framework instantiates per entry), the frame derives its
 * PropsStore share from the return type, and the service face receives the
 * bound actions through the registration's inject hook.
 */
import { defineStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CHART_RATIO_DEFAULT,
  clampRatio,
  clampWidth,
  DETAILS_DEFAULT,
  DETAILS_MAX,
  DETAILS_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from './columns.js'

/**
 * Layout store state: panel width preferences in px (0 = closed), plus the
 * narrow-viewport pair — `narrow` mirrors the frame's breakpoint reading so
 * toggleSidebar can pick semantics, and `narrowExpanded` is the manual
 * override that re-expands the auto-collapsed sidebar over the squeezed
 * center without rewriting the width preference.
 */
type LayoutState = {
  sidebar: number
  /** Chart share of the free width, 0 = closed. A ratio, not px — see CHART_RATIO_DEFAULT. */
  chart: number
  details: number
  narrow: boolean
  narrowExpanded: boolean
}

/**
 * Create the layout panel store handle. The preference IS the width, so
 * closing a panel forgets its drag width — reopening restores the contract
 * default. Actions are the complete write set: drag writes clamp into the
 * panel's contract range and never cross the open/closed line; open/close
 * transitions write 0 / the default explicitly.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore() {
  return defineStore({
    init: (): LayoutState => ({
      // Collapsed to the rail by default. Session history does not earn a
      // permanent column in a chart-first shell — the rail's search and the
      // conversation header reach it, and the width goes to the chart.
      sidebar: 0,
      chart: CHART_RATIO_DEFAULT,
      details: 0,
      narrow: false,
      narrowExpanded: false,
    }),
    actions: {
      setSidebar: (d: LayoutState, px: number) => {
        d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX)
      },
      setChart: (d: LayoutState, ratio: number) => {
        d.chart = clampRatio(ratio)
      },
      openChart: (d: LayoutState) => {
        if (d.chart === 0) d.chart = CHART_RATIO_DEFAULT
      },
      closeChart: (d: LayoutState) => {
        d.chart = 0
      },
      toggleChart: (d: LayoutState) => {
        d.chart = d.chart === 0 ? CHART_RATIO_DEFAULT : 0
      },
      setDetails: (d: LayoutState, px: number) => {
        d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX)
      },
      toggleSidebar: (d: LayoutState) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      setNarrow: (d: LayoutState, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      openDetails: (d: LayoutState) => {
        if (d.details === 0) d.details = DETAILS_DEFAULT
      },
      closeDetails: (d: LayoutState) => {
        d.details = 0
      },
    },
  })
}
