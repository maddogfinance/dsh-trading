/**
 * Pure tool-name policy. Kept free of cordis so the rules can be unit-tested
 * and audited on their own — a safety rule nobody can read in isolation is a
 * safety rule nobody checks.
 * @module @dsh-trading/risk-guard
 */

/** How the guard decides which tool names may run. */
export type GuardMode = 'denylist' | 'allowlist'

/**
 * Names matching these run-order or move-money shapes are refused. The list is
 * curated, anchored, and deliberately fail-closed: a research tool caught by
 * `^(buy|sell)_` is an annoyance a deployment fixes with one `allow` entry,
 * while an execution tool slipping through is the failure this package exists
 * to prevent.
 *
 * Patterns are matched against {@link nameCandidates} — the raw name's
 * normalized form and each of its namespace segments — so `placeOrder`,
 * `mcp__ib__place_order`, and `broker.place_order` all hit `^place_order$`
 * spellings the same way the textbook name does.
 *
 * Name matching is a HEURISTIC and cannot be complete — a broker tool called
 * `broker_action` matches nothing here. It is defense in depth for third-party
 * plugins, not the project's safety guarantee; that guarantee is structural
 * (dsh-trading defines no order-execution seam at all).
 */
export const DEFAULT_DENY_PATTERNS: readonly string[] = [
  // Order lifecycle, in both `verb_noun` and `noun_verb` spellings.
  '^(place|submit|send|create|open|cancel|amend|modify|replace|execute)_(order|orders|trade|trades)$',
  '^(order|orders|trade|trades)_(place|submit|send|create|cancel|amend|modify|replace|execute)$',
  // Bare directional verbs a broker or exchange plugin typically exposes.
  '^(buy|sell|short|cover|long)(_.*)?$',
  // Position lifecycle.
  '^(open|close|flatten|liquidate|exit)_(position|positions)$',
  // Money movement, including custody and on-chain transfers.
  '^(withdraw|withdrawal|deposit|transfer|remit|swap|bridge)(_.*)?$',
]

/** One guard decision. `allowed: false` carries the model-facing reason. */
export type GuardVerdict = { allowed: true } | { allowed: false; reason: string }

export interface GuardPolicy {
  mode: GuardMode
  /** Regex sources refused in `denylist` mode. Ignored in `allowlist` mode. */
  deny: readonly string[]
  /**
   * In `denylist` mode, exact names exempted from {@link GuardPolicy.deny}.
   * In `allowlist` mode, the exact names that are the ONLY ones permitted.
   */
  allow: readonly string[]
}

const HOW_TO_ALLOW = 'If this tool only reads or analyses data, add its exact name to the risk-guard `allow` list in your profile\'s cordis.patch.yml.'

/**
 * The forms a tool name is matched under. Real deployments rarely present the
 * textbook `place_order`: MCP servers prefix (`mcp__ib__place_order`), routers
 * namespace with dots, slashes, or colons (`broker.place_order`), and many
 * plugins camelCase (`placeOrder`). Matching only the raw spelling would make
 * every one of those a systematic bypass, so the deny patterns run over the
 * lowercased snake_case full name AND each namespace segment. Anchors still
 * anchor per candidate — `uniswap` never matches `^swap`. The broadening is
 * deliberately fail-closed: an over-caught research tool costs one `allow`
 * entry; an execution tool slipping through is the failure this package
 * exists to prevent.
 * @param name - the tool name exactly as the harness reports it.
 * @returns the normalized full name first, then its segments, deduplicated.
 */
export function nameCandidates(name: string): string[] {
  const snake = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2') // HTTPSell -> HTTP_Sell
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')    // placeOrder -> place_Order
    .toLowerCase()
  const segments = snake
    .split(/[./:\s]+|_{2,}/)                  // namespace separators
    .map(s => s.replace(/-+/g, '_').replace(/^_+|_+$/g, ''))
    .filter(s => s.length > 0)
  if (segments.length === 0) return [snake]
  return [...new Set([segments.join('_'), ...segments])]
}

/**
 * Compile the policy once per activation so a hot-reloaded config fails on a
 * bad pattern at load time rather than mid-turn on the first call it guards.
 * @param policy - the deployment's configured rules.
 * @returns a verdict function over tool names.
 */
export function compilePolicy(policy: GuardPolicy): (name: string) => GuardVerdict {
  const allow = new Set(policy.allow)
  if (policy.mode === 'allowlist') {
    return name => allow.has(name)
      ? { allowed: true }
      : {
          allowed: false,
          reason: `\`${name}\` is blocked: this deployment runs the dsh-trading risk guard in allowlist mode, where only explicitly permitted tools may run. ${HOW_TO_ALLOW}`,
        }
  }
  const denied = policy.deny.map((source, i) => {
    try {
      return new RegExp(source, 'i')
    } catch (cause) {
      throw new Error(`risk-guard: deny[${i}] is not a valid regular expression: ${source}`, { cause })
    }
  })
  return (name) => {
    if (allow.has(name)) return { allowed: true }
    for (const candidate of nameCandidates(name)) {
      const hit = denied.find(re => re.test(candidate))
      if (!hit) continue
      const via = candidate === name ? '' : ` via its normalized form \`${candidate}\``
      return {
        allowed: false,
        reason: `\`${name}\` is blocked by the dsh-trading risk guard: this deployment is research-only and does not place orders or move funds (matched \`${hit.source}\`${via}). ${HOW_TO_ALLOW}`,
      }
    }
    return { allowed: true }
  }
}
