/**
 * Browser half: the trading frame plugin. One register() call contributes
 * TradingFrame into the runtime's built-in 'root' slot and, in the same
 * breath, declares the four child slots (declaration = exclusive render
 * authority), seats the layout store (panel geometry), and wires the
 * panel-action service face. A second effect seats the theme presenter.
 *
 * This row REPLACES dsh's `ui-layout` row — it does not sit beside it. Slot
 * core allows exactly one declarer per slot key ("declaring an already-declared
 * child key throws"), so the stock row must be `disabled: true` in the profile
 * for this one to load. The four child keys are declared under their stock
 * names on purpose: ui-sidebar and ui-conversation register by name and mount
 * unchanged.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: brings ui-conversation's header-slot declarations into scope so
// the switcher can claim a seat there.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from './slots.js'
import { LayoutController } from './service.js'
import { createLayoutStore } from './stores.js'
import { installFrameStyles } from './styles.js'
import { SessionSwitcher } from './SessionSwitcher.js'
import { ThemePresenter } from './theme-presenter.js'
import { TradingFrame } from './TradingFrame.js'

export { LayoutController } from './service.js'
export type { ILayout } from './service.js'

// The seat contract, re-exported as real types on purpose. A bare
// `import type {} from './slots.js'` is elided from the emitted .d.ts, which
// would leave downstream plugins unable to see the SlotMap augmentation — a
// plugin filling `trading.chart` needs these names to resolve the key at all.
export type { ChartOwnerProps, ConvOwnerProps, DetailsOwnerProps, SidebarOwnerProps } from './slots.js'

export const name = 'client-frame'

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'theme', 'sessions']

/**
 * Client plugin body: provide ctx.layout, then one register() call — the frame
 * into 'root' with the four child-slot declarations, the layout store seat,
 * and the inject hook that hands the store's bound actions to the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  installFrameStyles()

  const layout = new LayoutController()

  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register(
      {
        name: 'root',
        children: {
          'sidebar': { kind: 'single', scope: 'root' },
          'trading.chart': { kind: 'single', scope: 'session-maybe' },
          'conversation': { kind: 'single', scope: 'session-maybe' },
          'details': { kind: 'single', scope: 'session' },
          'shell.overlay': { kind: 'list', scope: 'root' },
        },
        store: createLayoutStore,
        inject: (actions) => {
          layout.attachPanels(actions)
          return {}
        },
      },
      TradingFrame,
    )
    return () => {
      disposeRegistration()
      disposeService()
    }
  }, 'client-frame: service + root registration')

  // The sidebar starts collapsed in this frame, so session history needs a
  // route that does not depend on expanding it. inject() means a profile
  // without ui-conversation simply never runs this — the frame still works.
  ctx.slots.inject('conversation.session.header.utilities', () => [
    ctx.slots.register(
      {
        name: 'conversation.session.header.utilities',
        id: 'trading-session-switcher',
        registrant: '@dsh-trading/client-frame',
        inject: () => ({ open: (id: string) => ctx.sessions.open(id as never) }),
      },
      SessionSwitcher,
    ),
  ])

  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => {
      presenter.apply(snapshot)
    })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'client-frame: theme presenter')
}
