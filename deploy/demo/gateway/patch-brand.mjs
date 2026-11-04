/**
 * Rebrand the browser surface to TradingDraw.
 *
 * dsh ships the product name in two build-time places: the served index.html
 * title and one constant in the renderer. Both are patched here rather than at
 * request time so the browser tab, history and accessibility tree agree.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const files = [
  ['/app/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html', '<title>DeepSeek Harness</title>', '<title>TradingDraw — every line has a source</title>'],
  ['/app/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js', 'const productTitle = "DeepSeek Harness";', 'const productTitle = "TradingDraw";'],
]

for (const [file, from, to] of files) {
  if (!existsSync(file)) throw new Error(`brand patch target missing: ${file}`)
  const source = readFileSync(file, 'utf8')
  if (source.includes(to)) {
    console.log(`already branded ${file}`)
    continue
  }
  if (!source.includes(from)) throw new Error(`brand patch target changed: ${file}`)
  writeFileSync(file, source.replace(from, to))
  console.log(`branded ${file}`)
}

// The stock browser surface opens with an internal-testing notice for DeepSeek
// Harness developers. On a public TradingDraw demo it is off-brand and blocks
// the composer until acknowledged. Complete the onboarding step silently.
const welcomeFile = '/app/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js'
const welcomeFrom = `\t\tfunction WelcomeNotice(props) {
\t\t\tconst { complete, controller, useWelcome, t } = props;`
const welcomeTo = `\t\tfunction WelcomeNotice(props) {
\t\t\tconst { complete } = props;
\t\t\t(0, react.useEffect)(() => {
\t\t\t\tcomplete();
\t\t\t}, [complete]);
\t\t\treturn null;
\t\t\tconst { controller, useWelcome, t } = props;`
const welcomeSource = readFileSync(welcomeFile, 'utf8')
if (!welcomeSource.includes(welcomeTo)) {
  if (!welcomeSource.includes(welcomeFrom)) throw new Error('welcome notice patch target changed')
  writeFileSync(welcomeFile, welcomeSource.replace(welcomeFrom, welcomeTo))
  console.log('patched welcome notice')
} else {
  console.log('welcome notice already patched')
}

// Hero copy: the stock conversation surface advertises the harness itself.
// Rename the hero and point the composer at the one thing this deployment does.
const conversationFile = '/app/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js'
let conversation = readFileSync(conversationFile, 'utf8')
const copy = [
  ['Into the Unknown', 'TradingDraw'],
  ['探索未至之境', 'TradingDraw'],
  ['Describe what you want to build', 'Ask the market analyst…'],
  ['描述你想要构建的内容', '问问市场分析师…'],
]
let changed = false
for (const [from, to] of copy) {
  if (conversation.includes(from)) {
    conversation = conversation.split(from).join(to)
    changed = true
  }
}
if (changed) {
  writeFileSync(conversationFile, conversation)
  console.log('patched hero copy')
} else {
  console.log('hero copy already patched')
}
