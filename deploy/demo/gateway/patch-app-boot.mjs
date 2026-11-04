/**
 * dsh 0.1.0-rc.6 calls `hmr.registerConfig()` while setting up the user patch
 * layer, but every published @deepseek-ai/cordis-plugin-hmr (1.0.20/1.0.21)
 * exposes no such method, so `dsh web` prints its URL and then dies at boot.
 * A deployed demo does not hot-reload its profile; make the watcher a no-op.
 *
 * This is deliberately a build-time check: if the upstream shape changes, the
 * build fails instead of shipping an image that cannot boot.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2] ?? '/app/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
const source = readFileSync(file, 'utf8')
const needle = 'if (hmr === void 0) throw new Error('
const replacement =
  "if (hmr === void 0 || typeof hmr.registerConfig !== 'function') return async () => {}; if (false) throw new Error("

if (source.includes(replacement)) {
  console.log(`already patched ${file}`)
  process.exit(0)
}
if (!source.includes(needle)) {
  throw new Error(`app-boot watcher shape changed in ${file}; review the patch`)
}
writeFileSync(file, source.replace(needle, replacement))
console.log(`patched ${file}`)
