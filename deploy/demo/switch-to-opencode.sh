#!/usr/bin/env bash
# Move the public demo from OpenRouter to an OpenCode Go key.
#
# The key is written to this machine's env file first (the same 0600 file that
# already holds the model key), then to Secret Manager, then bound to the
# Cloud Run service. Nothing is printed back.
#
# Usage:  ./switch-to-opencode.sh          (prompts, input hidden)
#         ./switch-to-opencode.sh <token>  (token in argv: avoid, it lands in history)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# Where the local copy of the key lives. Defaults to a per-user config file;
# set ENV_FILE to reuse an existing env file.
ENV_FILE="${ENV_FILE:-$HOME/.config/tradingdraw/opencode.env}"
PROJECT="${PROJECT:?set PROJECT to the GCP project id}"
REGION="${REGION:-asia-east2}"
SERVICE="${SERVICE:-dash-trading}"
SECRET="${SECRET:-tradingdraw-opencode-key}"
PUBLIC_HOST="${PUBLIC_HOST:-tradingdraw.celineyu.me}"

if [ -n "${OPENCODE_TOKEN_FILE:-}" ]; then
  # Preferred non-interactive path: the key arrives in a 0600 file, never in
  # argv or this script's output. The file is removed once it is stored.
  TOKEN="$(cat "$OPENCODE_TOKEN_FILE")"
elif [ "$#" -ge 1 ]; then
  TOKEN="$1"
else
  read -rsp "OpenCode API key: " TOKEN
  echo
fi
if [ -z "${TOKEN:-}" ]; then
  echo "empty token; nothing changed" >&2
  exit 2
fi

echo "== validating the key against the inference endpoint"
STATUS=$(curl -s -o /tmp/opencode-token-check.json -w '%{http_code}' \
  https://opencode.ai/inference/go/openai/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'x-opencode-session: tradingdraw-demo' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":1}')
if [ "$STATUS" != "200" ]; then
  echo "key check failed: HTTP $STATUS" >&2
  head -c 300 /tmp/opencode-token-check.json >&2 || true
  echo >&2
  echo "the live service is unchanged" >&2
  exit 3
fi
rm -f /tmp/opencode-token-check.json

echo "== storing in $ENV_FILE"
mkdir -p "$(dirname "$ENV_FILE")"
python3 - "$ENV_FILE" "$TOKEN" <<'PY'
import os, sys
path, token = sys.argv[1], sys.argv[2]
lines = []
if os.path.exists(path):
    with open(path, 'r', encoding='utf-8') as fh:
        lines = fh.read().splitlines()
found = False
for i, line in enumerate(lines):
    if line.startswith('OPENCODE_API_KEY='):
        lines[i] = f'OPENCODE_API_KEY={token}'
        found = True
if not found:
    lines.append(f'OPENCODE_API_KEY={token}')
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as fh:
    fh.write('\n'.join(lines) + '\n')
os.chmod(path, 0o600)
PY

if [ -n "${OPENCODE_TOKEN_FILE:-}" ] && [ -f "$OPENCODE_TOKEN_FILE" ]; then
  rm -f "$OPENCODE_TOKEN_FILE"
  echo "== removed the token file"
fi

echo "== writing Secret Manager version"
if gcloud secrets describe "$SECRET" --project "$PROJECT" >/dev/null 2>&1; then
  printf %s "$TOKEN" | gcloud secrets versions add "$SECRET" --data-file=- --project "$PROJECT" >/dev/null
else
  printf %s "$TOKEN" | gcloud secrets create "$SECRET" --data-file=- --project "$PROJECT" --replication-policy=automatic >/dev/null
fi
NUM=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT" \
  --member="serviceAccount:${NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" >/dev/null

echo "== building the OpenCode profile image"
VERSION="$(date +%Y%m%d-%H%M)"
TAG="tradingdraw:$VERSION"
"$HERE/build.sh" "$TAG"
IMAGE="asia-east2-docker.pkg.dev/$PROJECT/quantdata/tradingdraw:$VERSION"
docker tag "$TAG" "$IMAGE"
docker push "$IMAGE" >/dev/null

echo "== deploying $SERVICE"
gcloud run deploy "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE" \
  --update-env-vars "DASH_PUBLIC_HOST=$PUBLIC_HOST" \
  --set-secrets "OPENCODE_API_KEY=$SECRET:latest" \
  --quiet

echo
echo "done: https://$PUBLIC_HOST"
