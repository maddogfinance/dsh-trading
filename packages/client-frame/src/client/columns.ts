/**
 * Column solver for the trading frame — vendored from dsh's stock
 * `dsh-client-ui-layout` rather than imported: that package's row is disabled
 * in this profile, so its client bundle is never served to the browser and its
 * exports are unreachable at runtime. The math is ~20 pure lines and the
 * contract has been byte-stable across rc.6 → rc.8, so a copy is cheaper than
 * a dependency that only resolves at build time.
 *
 * Chain order is fixed by contract: keep center >= CENTER_MIN by shrinking
 * details, then auto-closing it. The sidebar never concedes; center absorbs
 * any remaining deficit as the last resort.
 */

/**
 * Conversation column floor.
 *
 * Deliberately well below dsh's stock 640: in the stock shell the conversation
 * IS the app and deserves that much room, but here it is the side column of a
 * chart-first workbench. Holding 640 would make a 70/30 split impossible on
 * any normal laptop — the chain would keep clawing width back from the chart,
 * which is exactly backwards for this frame.
 */
export const CENTER_MIN = 420

/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264

/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420

/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280

/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56

/**
 * Viewport width below which the sidebar auto-collapses to the rail; a manual
 * toggle below it re-expands over the squeezed center (see `narrowExpanded`).
 */
export const SIDEBAR_AUTO_COLLAPSE = 1024

/** Details drag clamp floor. */
export const DETAILS_MIN = 300

/** Details drag clamp ceiling. */
export const DETAILS_MAX = 520

/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360

/**
 * Chart drag clamp floor. A candlestick chart stops being readable well before
 * a text column does — below this the price axis and the last ~40 bars no
 * longer coexist — so the chart column concedes down to here and then closes
 * outright rather than degrading into a sliver.
 */
export const CHART_MIN = 420

/**
 * Share of the free width the chart takes before any user drag: the workbench
 * gets seven tenths, the conversation three.
 *
 * A RATIO rather than a pixel width, unlike every stock dsh column. "The chart
 * takes 70%" has to survive a window resize to mean anything; a stored pixel
 * preference silently becomes a different split on every screen.
 */
export const CHART_RATIO_DEFAULT = 0.7

/** Drag clamp on the ratio, so neither column can be dragged out of existence. */
export const CHART_RATIO_MIN = 0.2
export const CHART_RATIO_MAX = 0.85

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns {
  sidebar: number
  chart: number
  center: number
  details: number
}

/**
 * Clamp a ratio into the chart's contract range.
 * @param ratio - requested share of the free width.
 * @returns the clamped ratio.
 */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return CHART_RATIO_DEFAULT
  return Math.min(CHART_RATIO_MAX, Math.max(CHART_RATIO_MIN, ratio))
}

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the four column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic.
 *
 * The concession chain, most expendable first: shrink details → close details
 * → shrink the chart to its floor → close the chart → let center absorb what
 * is left. The sidebar never concedes (its rendered width is always the drag
 * preference or the collapsed rail), and the chart outranks details because
 * details is a transient inspector while the chart is the workbench.
 *
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param chart - chart width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @returns resolved widths; a 0 means visually closed (never unmounted).
 */
export function computeColumns(viewport: number, sidebar: number, chartRatio: number, details: number): Columns {
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)

  /** Solve the two flexible columns against a fixed sidebar and details width. */
  const split = (detailsWidth: number): Columns | null => {
    const room = viewport - s - detailsWidth
    if (chartRatio === 0) {
      return room >= CENTER_MIN ? { sidebar: s, chart: 0, center: room, details: detailsWidth } : null
    }
    // The chart may take its share only down to its own floor and only while
    // the conversation keeps its own — otherwise this split does not exist and
    // the caller concedes something else first.
    const ceiling = room - CENTER_MIN
    if (ceiling < CHART_MIN) return null
    const chart = Math.min(ceiling, Math.max(CHART_MIN, Math.round(room * clampRatio(chartRatio))))
    return { sidebar: s, chart, center: room - chart, details: detailsWidth }
  }

  // Details at its preference, then conceding to its floor, then closed.
  return split(d0)
    ?? (d0 === 0 ? null : split(DETAILS_MIN))
    ?? split(0)
    // Last resort: no room for both flexible columns — the conversation wins,
    // because a shell with no way to talk to the agent is not a shell.
    ?? { sidebar: s, chart: 0, center: Math.max(0, viewport - s), details: 0 }
}
