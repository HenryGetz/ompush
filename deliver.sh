#!/bin/sh
# pushover-notify/deliver.sh — dumb transport. POSTs the pre-encoded PO_BODY to
# PO_URL and appends one JSON result line to PO_LOG. No secrets, no message
# content in argv, files, or logs. Always exits 0.
set -u

if [ -z "${PO_BODY:-}" ]; then
  exit 0
fi

url="${PO_URL:-https://api.pushover.net/1/messages.json}"

# Releases of ompush before T3-child suppression send no PO_SESSION_FILE. For
# a T3 Code process still running from one of those, infer its transcript from
# the parent omp process and ask T3 whether the thread is a delegated child.
is_legacy_t3_subagent() {
  [ -r "/proc/$PPID/environ" ] || return 1
  command -v sqlite3 >/dev/null 2>&1 || return 1
  t3_home=$(tr '\0' '\n' <"/proc/$PPID/environ" 2>/dev/null | sed -n 's/^T3CODE_HOME=//p' | sed -n '1p')
  [ -n "$t3_home" ] || return 1
  database="$t3_home/userdata/statev2.sqlite"
  [ -f "$database" ] || return 1
  session=""
  for fd in /proc/$PPID/fd/*; do
    target=$(readlink "$fd" 2>/dev/null) || continue
    case "$target" in
      */.omp/agent/sessions/*.jsonl) ;;
      *) continue ;;
    esac
    # The session's own transcript is the writable one; a readable fd could
    # belong to another session and must not suppress this push.
    case "$(ls -l "$fd" 2>/dev/null | cut -c1-3)" in
      *w*) session="$target"; break ;;
    esac
  done
  if [ -n "$session" ]; then
    escaped=$(printf '%s' "$session" | sed "s/'/''/g")
    relationship=$(sqlite3 "file:$database?mode=ro" \
      "select case when t.thread_id is null then 'missing' else coalesce(json_extract(t.payload_json,'\$.lineage.relationshipToParent'),'top-level') end from orchestration_v2_projection_provider_threads pt left join orchestration_v2_projection_threads t on t.thread_id=pt.thread_id where json_extract(pt.payload_json,'\$.nativeThreadRef.nativeId')='$escaped' limit 1;" \
      2>/dev/null | sed -n '1p')
    case "$relationship" in
      subagent) return 0 ;;
      top-level) return 1 ;;
    esac
  fi

  # Some omp builds do not keep the transcript fd open. Ask T3 which thread
  # owns this process, then read that thread's lineage.
  mcp_url=$(tr '\0' '\n' <"/proc/$PPID/environ" 2>/dev/null | sed -n 's/^T3_MCP_URL=//p' | sed -n '1p')
  token=$(tr '\0' '\n' <"/proc/$PPID/environ" 2>/dev/null | sed -n 's/^T3_MCP_BEARER_TOKEN=//p' | sed -n '1p')
  [ -n "$mcp_url" ] && [ -n "$token" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  [ -f "$script_dir/t3-legacy-guard.mjs" ] || return 1
  T3CODE_HOME="$t3_home" T3_MCP_URL="$mcp_url" T3_MCP_BEARER_TOKEN="$token" \
    node "$script_dir/t3-legacy-guard.mjs"
}

if [ -z "${PO_SESSION_FILE:-}" ] && is_legacy_t3_subagent; then
  trace="${PO_TRACE:-$HOME/.local/state/omp-pushover/trace.log}"
  mkdir -p "$(dirname "$trace")" 2>/dev/null
  printf '{"ts":"%s","kind":"%s","action":"skip","reason":"t3-subagent-legacy"}\n' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${PO_KIND:-}" >>"$trace" 2>/dev/null
  exit 0
fi

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
