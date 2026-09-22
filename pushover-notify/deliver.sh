#!/bin/sh
# pushover-notify/deliver.sh — dumb transport. POSTs the pre-encoded PO_BODY to
# PO_URL and appends one JSON result line to PO_LOG. No secrets, no message
# content in argv, files, or logs. Always exits 0.
set -u

if [ -z "${PO_BODY:-}" ]; then
  exit 0
fi

url="${PO_URL:-https://api.pushover.net/1/messages.json}"

out=$(printf '%s' "$PO_BODY" | curl -sS --max-time 7 --data-binary @- -w '\n%{http_code}' "$url" 2>&1)
rc=$?

http=$(printf '%s' "$out" | sed -n '$p')
body=$(printf '%s' "$out" | sed '$d')

status=$(printf '%s' "$body" | sed -n 's/.*"status":\([0-9][0-9]*\).*/\1/p' | sed -n '1p')
request=$(printf '%s' "$body" | sed -n 's/.*"request":"\([^"]*\)".*/\1/p' | sed -n '1p')
request=$(printf '%s' "$request" | sed 's/["\\]//g')

[ -n "$http" ] || http=0
[ -n "$status" ] || status=0

log="${PO_LOG:-}"
if [ -n "$log" ]; then
  mkdir -p "$(dirname "$log")" 2>/dev/null
  ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  printf '{"ts":"%s","kind":"%s","spawn_ms":%s,"http":%s,"status":%s,"request":"%s","curl_rc":%s}\n' \
    "$ts" "${PO_KIND:-}" "${PO_SPAWN_MS:-0}" "$http" "$status" "$request" "$rc" >>"$log" 2>/dev/null
fi

exit 0
