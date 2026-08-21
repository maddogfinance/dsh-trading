/**
 * Global theme DOM applier: projects the resolved theme snapshot onto the
 * document — `html { color-scheme }` for native UA chrome, the body palette
 * attribute for the token stylesheets, the active theme's alias-token
 * overrides as inline CSS variables on body, and one presenter-owned
 * `meta[name="theme-color"]`.
 *
 * This seat belongs to whoever occupies the root slot: the stock layout plugin
 * installs it in a second effect, so a frame that replaces that row must
 * install it too — without this, no token variables reach `body` and every
 * `var(--dsw-*)` in the app resolves to nothing.
 */

/** Body attribute selecting the dark base palette in the token stylesheets. */
export const DARK_ATTRIBUTE = 'data-ds-dark-theme'

/** The shape of ctx.theme's snapshot this presenter reads. */
export interface ThemeSnapshotLike {
  active: {
    colorScheme: 'light' | 'dark'
    tokens: Record<string, string>
  }
}

/** Applies theme snapshots to the document; one instance per plugin fiber. */
export class ThemePresenter {
  /** Token names this presenter wrote in the last apply (its retraction set). */
  #appliedTokens: string[] = []

  /** The single metadata node this presenter inserts and removes. */
  readonly #themeColorMeta: HTMLMetaElement

  /** Create the presenter-owned metadata node before the first snapshot arrives. */
  constructor() {
    this.#themeColorMeta = document.createElement('meta')
    this.#themeColorMeta.name = 'theme-color'
  }

  /**
   * Project a snapshot onto the document. Browser theme-color metadata follows
   * the computed body background after those writes, so the rendered palette
   * remains the color authority.
   * @param snapshot - resolved theme snapshot from ctx.theme.
   */
  apply(snapshot: ThemeSnapshotLike): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    const body = document.body
    if (scheme === 'dark') body.setAttribute(DARK_ATTRIBUTE, '')
    else body.removeAttribute(DARK_ATTRIBUTE)
    for (const name of this.#appliedTokens) body.style.removeProperty(name)
    this.#appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      body.style.setProperty(name, value)
      this.#appliedTokens.push(name)
    }
    this.#themeColorMeta.content = getComputedStyle(body).backgroundColor
    if (!this.#themeColorMeta.isConnected) document.head.append(this.#themeColorMeta)
  }

  /** Retract root color-scheme, the palette attribute, token variables, and the owned metadata node. */
  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    const body = document.body
    body.removeAttribute(DARK_ATTRIBUTE)
    for (const name of this.#appliedTokens) body.style.removeProperty(name)
    this.#appliedTokens = []
    this.#themeColorMeta.remove()
  }
}
