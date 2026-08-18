/**
 * Refuse order-execution and fund-movement tools before they dispatch.
 *
 * dsh-trading's research-only stance is structural first: this project defines
 * no order-execution seam, so nothing it ships can trade. This plugin extends
 * that stance over tools it does NOT ship — a broker MCP server or any
 * third-party plugin mounted in the same profile — by denying such calls at the
 * `tools/pre-execute` gate. Remove the row to opt out; that removal is the
 * deliberate act the boundary asks for.
 * @module @dsh-trading/risk-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: merges the `tools/*` events and `ctx.tools` into the Context face.
import type {} from '@deepseek-ai/dsh-tools'
import { compilePolicy, DEFAULT_DENY_PATTERNS } from './policy.js'
import type { GuardMode } from './policy.js'

export { compilePolicy, DEFAULT_DENY_PATTERNS, nameCandidates } from './policy.js'
export type { GuardMode, GuardPolicy, GuardVerdict } from './policy.js'

export const name = 'risk-guard'
export const inject = ['tools']

export interface Config {
  /**
   * `denylist` (default) refuses names matching {@link Config.deny}.
   * `allowlist` refuses everything except {@link Config.allow} — for
   * deployments that would rather break loudly than rely on name heuristics.
   */
  mode: GuardMode
  /** Regex sources refused in `denylist` mode. */
  deny: string[]
  /** Exact names always permitted (and the whole permitted set in `allowlist` mode). */
  allow: string[]
}

export const Config: z<Config> = z.object({
  mode: z.union(['denylist', 'allowlist'] as const).default('denylist'),
  deny: z.array(z.string()).default([...DEFAULT_DENY_PATTERNS]),
  allow: z.array(z.string()).default([]),
})

export function apply(ctx: Context, config: Config): void {
  const verdict = compilePolicy(config)
  ctx.on('tools/pre-execute', (exec, next) => {
    const decision = verdict(exec.name)
    if (!decision.allowed) {
      ctx.logger?.warn?.('risk-guard denied tool call %s', exec.name)
      return Promise.resolve({ kind: 'deny' as const, reason: decision.reason })
    }
    return next()
  })
}
