# TradingDraw — public demo deployment

Live: **https://tradingdraw.celineyu.me**  (`dash.celineyu.me` and
`proofline.celineyu.me` 301 here)

A public instance of the TradingDraw workbench. Visitors get the live chart
column, the `market_snapshot` / `get_ohlcv` / `walkthrough` tools and the
Market Analyst preset, with no key, install or data feed of their own.

```
browser ──TLS──> Cloudflare Worker ──shared header──> Cloud Run (one instance)
                                                       └─ Node gateway
                                                           └─ one dsh child per visitor
                                                               ├─ OpenCode Go (DeepSeek V4.1 Flash)
                                                               └─ Yahoo Finance public candles
```

## What is embedded

| Service | Where it lives | Key? |
|---|---|---|
| Model | `@deepseek-ai/dsh-llm-pi-ai` → OpenCode Go, `deepseek-v4.1-flash` | `OPENCODE_API_KEY`, Cloud Run secret only |
| Market data | `@dsh-trading/provider-public` → Yahoo Finance chart endpoint | none |
| Analysis tools | `@dsh-trading/tool-market`, incl. `walkthrough` (built from this checkout) | none |
| Chart UI | `@dsh-trading/client-chart` (built from this checkout) | none |
| Shell | `@dsh-trading/client-frame` (built from this checkout) | none |

`provider-public` is the keyless feed: equities, ETFs, indices, FX, futures and
crypto pairs (`BTC-USD`, `ETH-USD`, `AAPL`, `SPY`, `^GSPC`, `GC=F`, `EURUSD=X`).
It is a demo feed deliberately: undocumented endpoint, 20s/5min in-process
cache, fails loud on a missing series rather than serving a stale one.

## Security model

The API key never reaches the browser:

- The key is a Cloud Run **secret**, injected as `OPENROUTER_API_KEY` into the
  gateway and inherited by each child. It is absent from the image, the Worker,
  the HTML and every client bundle (verified by grepping the deployed assets for
  the key prefix).
- The Worker adds `x-dash-gateway`; the gateway rejects anything without it, so
  the raw `*.run.app` origin is a **403** back door even though Cloud Run is
  publicly invocable.
- Each visitor gets a random `dash_vid` cookie, their own `DSH_HOME`, their own
  dsh process and their own session store. `session.list` for visitor B is empty
  and visitor A's session id returns `session-not-found` for B.
- The request is rewritten to loopback before it reaches dsh, so the stock
  browser-trust fence treats it as local. The gateway is the only trust boundary.
- Only one preset is installed (Market Analyst). The coding presets that mount
  fs/bash/subagent tools are deleted from the image, so there is no tool to
  reach a shell even if a visitor asks.
- `settings.update/replace/mutate`, `credentials.*`, `host.pickDirectory`,
  `host.openPath` and preset authoring are refused. The single exception is the
  stock onboarding acknowledgement (`ui-onboarding`), which is otherwise an
  un-dismissable modal.
- Quotas: 20 prompts per visitor per UTC day, 40 per IP, 300 globally. Four dsh
  children at a time; the least-recently-used idle one is evicted (its home and
  chat survive, the visitor waits ~4s for a respawn). Cloud Run is capped at one
  instance so WebSocket routing cannot land on another instance.

## Cost controls

- Model: DeepSeek V4.1 Flash through OpenCode Go (`$0.15`/M input, `$0.60`/M
  output, 1M context). The key's own plan/limit is the ceiling.
- Cloud Run: 2 vCPU / 4 GiB, `min-instances=0`, `max-instances=1`, request-based
  CPU. Idle means scale to zero; per prompt the agent's usage is a few thousand
  tokens.
- Market data: Yahoo's public endpoint, no metered key.

## Rebuild and deploy

Prerequisites: Docker, `gcloud` authenticated to `project-d3a45b0b-ed4d-4268-ad8`,
`wrangler` logged in to the Cloudflare account that owns `celineyu.me`.

```sh
cd deploy/demo
./build.sh                 # build packages, pack tarballs, build image
# then:
docker tag dash-trading:local \
  asia-east2-docker.pkg.dev/project-d3a45b0b-ed4d-4268-ad8/quantdata/dash-trading:$(date +%Y%m%d-%H%M)
docker push ...
gcloud run deploy dash-trading --image=... --region=asia-east2
```

The Docker build on this machine needs `--network host` (the default Docker
bridge cannot reach the npm registry). `build.sh` passes it.

First-time secrets:

```sh
printf %s "$OPENCODE_API_KEY" | gcloud secrets create tradingdraw-opencode-key --data-file=-
gcloud run services update dash-trading \
  --update-env-vars DASH_GATEWAY_TOKEN=$(openssl rand -hex 24)
cd worker && wrangler secret put DASH_GATEWAY_TOKEN
```

`switch-to-opencode.sh` does the local env-file write, the secret rotation, the
IAM grant and the redeploy in one step.

`DASH_PUBLIC_HOST` (now `tradingdraw.celineyu.me`), `DASH_MAX_CHILDREN`,
`DASH_VISITOR_PROMPTS`, `DASH_IP_PROMPTS` and `DASH_DAILY_PROMPTS` are ordinary
Cloud Run env vars. The `DASH_*` prefix is internal compatibility; it is not a
product name.

## Pinned dependencies

`package-lock.json` is committed and the image installs with `npm ci`. Without
it, npm re-resolves the tree on every build and a floating minor took the demo
down: `@deepseek-ai/cordis` 4.1.0 landed on 11/4, and dsh 0.1.0-rc.6's preset
loader reads a `parent` field 4.1.0 no longer sets, so every `session.create`
failed with `agent-preset-invalid` and the workspace picker could not open a
session. `overrides` in `package.json` hold the cordis family at the versions
the working image had (cordis 4.0.5, plugin-loader 1.0.6, hmr 1.0.20,
plugin-group 1.0.5, plugin-include 1.0.10, plugin-timer 1.1.7, cosmokit 1.8.6,
schemastery 3.18.5). Re-test the picker after touching any of them.

## Image patches

Two upstream issues are patched at build time, both fail-loud if the upstream
shape changes:

- `patch-app-boot.mjs` — dsh 0.1.0-rc.6 calls `hmr.registerConfig()`, which no
  published `cordis-plugin-hmr` implements; without the patch every child
  prints its URL and exits. The demo does not hot-reload, so the watcher is a
  no-op.
- `patch-brand.mjs` — title, hero, composer copy, and the internal-testing
  notice. The notice blocks the composer until acknowledged and is about a
  different product; it is completed silently instead.

## Known limits

- Cold start ~5–10s (Cloud Run scales to zero).
- Four concurrent analysts; a fifth visitor evicts the idlest child.
- Yahoo's endpoint is not a licensed production feed. If this ever becomes a
  paid product, swap `provider-public` for a metered provider behind the same
  `MarketDataProvider` seam.
