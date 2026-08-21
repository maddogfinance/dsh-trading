/**
 * Frame stylesheet, injected once per document under a plugin-owned tag id
 * (the same convention dsh's own client CSS modules use, so a reload replaces
 * rather than stacks). Class names are prefixed to avoid colliding with the
 * stock layout plugin's hashed names should both ever be present.
 *
 * Colors come from the deepsuite alias tokens the theme presenter writes onto
 * `body`, never from literals — the frame must follow the user's theme.
 */

const TAG_ID = '@dsh-trading/client-frame/frame.css'

const CSS = `
.dshtf-frame {
  background: var(--dsw-alias-bg-base);
  height: 100%;
  display: grid;
  grid-template-rows: 100%;
  position: relative;
  overflow: hidden;
  transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
.dshtf-frame[data-dragging] { transition: none; }
@media (prefers-reduced-motion: reduce) { .dshtf-frame { transition: none; } }

.dshtf-sidebarCol {
  background: var(--dsw-specific-sidebar-fill);
  border-right: 1px solid var(--dsw-alias-border-l1);
  min-width: 0;
  overflow: hidden;
}
.dshtf-chartCol {
  border-right: 1px solid var(--dsw-alias-border-l2);
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.dshtf-frame[data-chart-collapsed] .dshtf-chartCol { border-right: none; }

.dshtf-chartEmpty {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 0 24px;
  text-align: center;
  color: var(--dsw-alias-text-3);
  font-size: 13px;
}
.dshtf-chartEmptyHint { font-size: 12px; opacity: 0.75; }

.dshtf-centerCol { display: flex; flex-direction: column; min-width: 0; overflow: hidden; }
.dshtf-detailsCol { border-left: 1px solid var(--dsw-alias-border-l2); min-width: 0; overflow: hidden; }
.dshtf-frame[data-details-collapsed] .dshtf-detailsCol { border-left: none; }

.dshtf-handle {
  cursor: col-resize;
  z-index: 2;
  touch-action: none;
  width: 8px;
  margin-left: -4px;
  position: absolute;
  top: 0;
  bottom: 0;
  transition: left var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
.dshtf-frame[data-dragging] .dshtf-handle { transition: none; }
@media (prefers-reduced-motion: reduce) { .dshtf-handle { transition: none; } }

.dshtf-handle[data-side="chart"]::after,
.dshtf-handle[data-side="details"]::after {
  content: "";
  box-sizing: border-box;
  background: var(--dsw-alias-button-floating-fill);
  border: 1px solid var(--dsw-alias-border-l2-darkmode-thin);
  opacity: 0;
  width: 12px;
  height: 32px;
  border-radius: 10px;
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  transition: opacity var(--ds-transition-duration-slow) var(--ds-ease-in-out),
    background var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
.dshtf-detailsCol:hover ~ .dshtf-handle[data-side="details"]::after,
.dshtf-chartCol:hover ~ .dshtf-handle[data-side="chart"]::after,
.dshtf-handle[data-side="chart"]:hover::after,
.dshtf-handle[data-side="chart"][data-dragging="true"]::after,
.dshtf-handle[data-side="details"]:hover::after,
.dshtf-handle[data-side="details"][data-dragging="true"]::after { opacity: 1; }
.dshtf-handle[data-side="chart"]:hover::after,
.dshtf-handle[data-side="chart"][data-dragging="true"]::after,
.dshtf-handle[data-side="details"]:hover::after,
.dshtf-handle[data-side="details"][data-dragging="true"]::after {
  background: var(--dsw-alias-button-floating-hover);
  border-color: var(--dsw-alias-border-l3);
}

.dshtf-switcher { position: relative; display: inline-flex; }
.dshtf-switcherTrigger {
  background: transparent;
  color: var(--dsw-alias-text-2, inherit);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3));
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.dshtf-switcherTrigger:hover { border-color: var(--dsw-alias-border-l3, rgba(128,128,128,0.6)); color: var(--dsw-alias-text-1, inherit); }
.dshtf-switcherItem {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  color: var(--dsw-alias-text-1, inherit);
  border: none;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshtf-switcherItem:hover { background: var(--dsw-alias-bg-hover, rgba(128,128,128,0.14)); }
.dshtf-switcherItem[data-current] { color: var(--dsw-alias-text-brand, inherit); font-weight: 600; }
.dshtf-switcherEmpty { padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-text-3, rgba(128,128,128,0.9)); }

.dshtf-overlayLayer { z-index: 20; pointer-events: none; position: absolute; inset: 0; }
.dshtf-overlayLayer > * { pointer-events: auto; }
`

/** Inject the frame stylesheet once; idempotent across plugin reloads. */
export function installFrameStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG_ID)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset['plugin'] = '@dsh-trading/client-frame'
  tag.dataset['pluginCss'] = TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** Class-name map, mirroring the CSS-module shape the stock frame uses. */
export const styles = {
  frame: 'dshtf-frame',
  sidebarCol: 'dshtf-sidebarCol',
  chartCol: 'dshtf-chartCol',
  chartEmpty: 'dshtf-chartEmpty',
  chartEmptyHint: 'dshtf-chartEmptyHint',
  centerCol: 'dshtf-centerCol',
  detailsCol: 'dshtf-detailsCol',
  handle: 'dshtf-handle',
  overlayLayer: 'dshtf-overlayLayer',
  switcher: 'dshtf-switcher',
  switcherTrigger: 'dshtf-switcherTrigger',
  switcherItem: 'dshtf-switcherItem',
  switcherEmpty: 'dshtf-switcherEmpty',
} as const
