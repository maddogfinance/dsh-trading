/**
 * Two-half build, mirroring client-chart. The server half (src/index.ts) is
 * ordinary tsc output; the browser half (src/client) must arrive as a single
 * classic script whose only top-level statement hands a lazy CJS factory to
 * the dsh web module loader — the host provides react and the dsh-client
 * packages through the factory's `require`, so they stay external. This
 * package bundles nothing of its own: the frame is pure React over the
 * framework shares.
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Must match the package name exactly: the host looks the bundle up by id.
const PLUGIN_ID = '@dsh-trading/client-frame'

const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-conversation/client',
]

const tsc = resolve(root, 'node_modules/typescript/bin/tsc')

// Host half: JS + declarations into lib/.
execFileSync(process.execPath, [tsc, '-p', resolve(root, 'tsconfig.json')], { stdio: 'inherit' })

// Browser half: declarations only, into lib/types/client/. The JS comes from
// esbuild below; these .d.ts files are what lets a downstream plugin import
// the `trading.chart` slot declaration as a type-only dependency.
execFileSync(process.execPath, [tsc, '-p', resolve(root, 'tsconfig.client.json')], { stdio: 'inherit' })

await build({
  entryPoints: [resolve(root, 'src/client/index.ts')],
  outfile: resolve(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: EXTERNALS,
  charset: 'utf8',
  logLevel: 'warning',
  sourcemap: true,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`
      + ' var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
})
