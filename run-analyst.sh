#!/usr/bin/env bash
# Launch the trading profile with an API key taken from the environment.
#
#   export OPENAI_API_KEY=sk-...     # in THIS shell
#   ./run-analyst.sh
#
# Copy-pasted keys routinely arrive with a trailing newline or wrapping quotes,
# which reach the provider as an HTTP header value that cannot carry them. The
# key never enters a file — dsh's profile config names the variable only, and
# this script sanitizes the value in its own process and passes it through the
# environment.
set -euo pipefail

VAR="${DSH_TRADING_KEY_VAR:-OPENAI_API_KEY}"
raw="${!VAR:-}"

if [[ -z "$raw" ]]; then
  echo "$VAR is not set in THIS shell." >&2
  echo "Export it here (not in another window), then re-run:" >&2
  echo "    export $VAR=sk-..." >&2
  exit 1
fi

# Whitespace is never key material; surrounding quotes are a paste artifact.
key="${raw//[[:space:]]/}"
key="${key#[\"\']}"
key="${key%[\"\']}"

# Header values must be printable ASCII. Report only the position, never the
# character: a diagnostic that echoes key material defeats the point.
if printf '%s' "$key" | LC_ALL=C grep -q '[^[:print:]]'; then
  offset=$(LC_ALL=C awk -v s="$key" 'BEGIN{for(i=1;i<=length(s);i++){c=substr(s,i,1);if(c<" "||c>"~"){print i;exit}}}')
  echo "$VAR still holds a character no HTTP header can carry, at position ${offset:-?} of ${#key}." >&2
  echo "Re-copy the key from a plain-text source — rich text (docs, PDFs, chat apps)" >&2
  echo "can substitute typographic quotes or zero-width characters." >&2
  exit 1
fi

if [[ "$key" != "$raw" ]]; then
  echo "note: trimmed whitespace/quotes from $VAR (${#raw} -> ${#key} chars)" >&2
fi

cd "$(dirname "$0")"
export "$VAR=$key"
exec npx -y @deepseek-ai/dsh@0.1.0-rc.6 --profile trading "$@"
