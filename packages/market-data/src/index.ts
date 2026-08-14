/**
 * `ctx.marketData`: the provider registry the rest of dsh-trading talks to.
 * The service owns no IO — providers own their media (files, databases,
 * exchange APIs); this hub only routes queries and scopes registrations to
 * the registering plugin's lifetime.
 * @module @dsh-trading/market-data
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Candle, InstrumentInfo, MarketDataProvider, OhlcvQuery } from './types.js'

export type * from './types.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    marketData: MarketData
  }
}

/**
 * The market-data hub. Providers register under their id and unregister via
 * the returned disposer; consumers resolve by id or take the default (the
 * sole provider, or the one named by `defaultProvider`).
 */
export class MarketData extends Service {
  private readonly providers = new Map<string, MarketDataProvider>()
  private defaultId: string | undefined

  constructor(ctx: Context, config: MarketData.Config = {}) {
    super(ctx, 'marketData')
    this.defaultId = config.defaultProvider
  }

  /**
   * Mount a provider. Duplicate ids fail loud — two silently-shadowing data
   * sources is exactly the ambiguity a research log must never contain.
   * @returns the disposer that unmounts the provider.
   */
  register(provider: MarketDataProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`market-data provider '${provider.id}' is already registered`)
    }
    this.providers.set(provider.id, provider)
    return () => {
      if (this.providers.get(provider.id) === provider) {
        this.providers.delete(provider.id)
      }
    }
  }

  /** Ids of all mounted providers, registration-ordered. */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Resolve a provider. With no id: the configured default when set, else
   * the sole mounted provider; ambiguity (zero or several, none default)
   * throws rather than guessing where data comes from.
   */
  provider(id?: string): MarketDataProvider {
    if (id !== undefined) {
      const found = this.providers.get(id)
      if (!found) {
        throw new Error(`unknown market-data provider '${id}' (mounted: ${this.list().join(', ') || 'none'})`)
      }
      return found
    }
    if (this.defaultId !== undefined) return this.provider(this.defaultId)
    if (this.providers.size === 1) return [...this.providers.values()][0]!
    throw new Error(
      this.providers.size === 0
        ? 'no market-data provider is mounted'
        : `several providers are mounted (${this.list().join(', ')}); pass an id or configure defaultProvider`,
    )
  }

  /** Convenience: route one candle query through the resolved provider. */
  getOhlcv(query: OhlcvQuery, providerId?: string): Promise<Candle[]> {
    return this.provider(providerId).getOhlcv(query)
  }

  /** Convenience: enumerate instruments of the resolved provider. */
  listSymbols(providerId?: string): Promise<InstrumentInfo[]> {
    return this.provider(providerId).listSymbols()
  }
}

export namespace MarketData {
  export interface Config {
    /** Provider id consumers get when they don't name one. */
    defaultProvider?: string
  }
}

export default MarketData
