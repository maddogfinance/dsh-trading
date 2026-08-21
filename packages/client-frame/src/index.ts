/**
 * Host half of the trading-frame package. The interesting half lives in
 * ./client — this entry only gives the profile's Loader row a valid plugin to
 * mount, so the dsh web host scans the package's `dsh.client` manifest and
 * serves the browser bundle. It registers nothing and touches nothing.
 * @module @dsh-trading/client-frame
 */

export const name = 'client-frame'

export function apply(): void {
  // Intentionally empty: presentation only, no host-side capability.
}
