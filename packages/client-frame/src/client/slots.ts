/**
 * Slot contract of the trading frame: the four child seats it declares inside
 * the built-in 'root' hole.
 *
 * These four keys carry the SAME names dsh's stock `ui-layout` declares, and
 * that is the whole trick — ui-sidebar and ui-conversation register by name,
 * so they mount into a third-party frame unchanged. Slot core permits exactly
 * one declarer per key, so this augmentation and the stock plugin's are
 * mutually exclusive at runtime: the profile disables the `ui-layout` row.
 *
 * The declarations are duplicated here rather than imported from ui-layout on
 * purpose — importing its types would pull its `declare module` block into
 * this compilation and collide with ours on every key.
 */
import type { ReactNode } from 'react'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The whole left column. Occupied by ui-sidebar's SidebarRoot, which
     * declares the workspace and settings seats inside it. The occupant
     * receives the frame's live column state and renders the compact control
     * rail while collapsed.
     */
    'sidebar': {
      kind: 'single'
      scope: 'root'
      owner: SidebarOwnerProps
    }
    /**
     * The whole center column, across both the no-session hero and a live
     * conversation. Occupied by ui-conversation's ConversationRoot, which
     * declares the session body, composer, and input seats inside it.
     */
    'conversation': {
      kind: 'single'
      scope: 'session-maybe'
      owner: ConvOwnerProps
    }
    /**
     * The right details column, shown when the layout opens it. Occupied by
     * ui-conversation's DetailsPanel, which declares the tool-details seat
     * inside it. Absent an occupant the column renders nothing.
     */
    'details': {
      kind: 'single'
      scope: 'session'
      owner: DetailsOwnerProps
    }
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers. The layer itself is click-through — entries opt back into
     * pointer events — so an occupant never blocks the app underneath.
     */
    'shell.overlay': {
      kind: 'list'
      scope: 'root'
    }
    /**
     * The persistent chart column, sitting between the sidebar and the
     * conversation — the one seat that has no counterpart in dsh's stock
     * frame. Single: one occupant owns the whole workbench column, the way
     * ui-conversation owns the center.
     *
     * `session-maybe` on purpose: the chart is not an artifact of one
     * conversation. It keeps its symbol, timeframe, and drawings across a
     * session switch and stays up on the no-session hero, so the user can
     * study a chart before deciding what to ask.
     *
     * Absent an occupant the frame's own placeholder fills the column (the
     * `fallback` at the render site), so a profile that installs the frame
     * without a chart plugin shows an explained empty column rather than a
     * dead gutter.
     */
    'trading.chart': {
      kind: 'single'
      scope: 'session-maybe'
      owner: ChartOwnerProps
    }
  }
}

/** Chart owner share: live column state from the frame's concession solve. */
export interface ChartOwnerProps {
  /** Rendered column width in px. */
  width: number
}

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the sidebar is closed (the column renders the compact control rail). */
  collapsed: boolean
  /** Rendered column width in px (SIDEBAR_COLLAPSED when collapsed). */
  width: number
}

/** Conversation owner share: business state and actions belong to the registrant. */
export interface ConvOwnerProps {}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/** Keeps this a module under `isolatedModules` even when only types are used. */
export type FrameSlotChildren = ReactNode
