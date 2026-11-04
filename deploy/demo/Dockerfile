# The public TradingDraw demo.
#
# One Cloud Run instance, one Node gateway, one dsh child per visitor. The image
# contains no credentials: the model key arrives as a Cloud Run secret and is
# inherited by the children at runtime.

# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# The two packages that are not on npm are packed from the checkout first.
COPY artifacts/ /app/artifacts/
COPY package.json /app/package.json
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund --legacy-peer-deps

# Profile + gateway + the single preset the demo allows.
COPY profile/ /app/dsh-home/profiles/dash/
RUN ln -s /app/node_modules /app/dsh-home/profiles/dash/node_modules
COPY presets/ /app/presets/
COPY gateway/ /app/gateway/

# dsh 0.1.0-rc.6 watches the user patch layer through an HMR API that the
# published cordis-plugin-hmr does not implement (registerConfig). A demo does
# not hot-reload its profile, so make that watcher a no-op instead of crashing
# every child at boot. This is the only source change in the image.
RUN node /app/gateway/patch-app-boot.mjs /app/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js \
 && node /app/gateway/patch-brand.mjs \
 && node -e "require('fs').accessSync('/app/node_modules/@deepseek-ai/dsh/lib/bin.js')"

# Ship exactly one preset. The coding presets mount fs/bash/subagent tools and
# have no business in a public chat surface.
RUN rm -rf /app/node_modules/@deepseek-ai/dsh/config/agent-presets \
 && mkdir -p /app/node_modules/@deepseek-ai/dsh/config/agent-presets \
 && cp -r /app/presets/analyst /app/node_modules/@deepseek-ai/dsh/config/agent-presets/analyst

RUN mkdir -p /data/visitors \
 && chown -R node:node /data /app/dsh-home

USER node

ENV PORT=8080 \
    DASH_PUBLIC_HOST=tradingdraw.celineyu.me \
    DASH_PROFILE=dash \
    DASH_SHARED_HOME=/app/dsh-home \
    DASH_VISITOR_ROOT=/data/visitors \
    DASH_DSH_BIN=/app/node_modules/@deepseek-ai/dsh/lib/bin.js \
    DSH_TELEMETRY_DISABLED=1

EXPOSE 8080

CMD ["node", "/app/gateway/server.mjs"]
