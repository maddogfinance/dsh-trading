/**
 * LayoutController: the cross-plugin panel-action face behind `ctx.layout`.
 * ui-sidebar (sidebar toggle) and ui-conversation (details open/close) inject
 * this service by name, so the trading frame MUST provide it under the same
 * key as the stock layout plugin — dropping it would leave both stock rows
 * unable to load.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.js'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the panel transitions other plugins
 * may trigger — and exactly what a test fake must supply.
 */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
  /**
   * Open the chart column (no-op when already open). Beyond the stock
   * contract: this is how a trading plugin reveals the workbench when the
   * model produces a chart the user has closed the column on.
   */
  openChart(): void
  /** Close the chart column. */
  closeChart(): void
  /** Toggle the chart column (closed ⟷ contract default width). */
  toggleChart(): void
}

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render; on entry re-register the fresh
   * actions overwrite the stale set.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /** Open the details panel (no-op when already open). */
  openDetails(): void {
    this.#require().openDetails()
  }

  /** Close the details panel. */
  closeDetails(): void {
    this.#require().closeDetails()
  }

  /** Open the chart column (no-op when already open). */
  openChart(): void {
    this.#require().openChart()
  }

  /** Close the chart column. */
  closeChart(): void {
    this.#require().closeChart()
  }

  /** Toggle the chart column (closed ⟷ contract default width). */
  toggleChart(): void {
    this.#require().toggleChart()
  }

  #require(): PanelActions {
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
