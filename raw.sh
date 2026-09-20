#!/usr/bin/env bash
# A2A v1.0 with bare hands: no SDK, no client — just curl.
# Every method and header name below was captured from live traffic.
set -euo pipefail
AGENT="${AGENT:-http://localhost:41241}"
J='Content-Type: application/json'
V='A2A-Version: 1.0'   # without it the server takes you for a v0.3 client and answers -32009
jq_or_cat() { command -v jq >/dev/null && jq "$@" || python3 -m json.tool; }

banner() { printf '\n\033[36m── %s ──\033[0m\n' "$1"; }

banner "1. Discovery: the Agent Card"
curl -s "$AGENT/.well-known/agent-card.json" | jq_or_cat

banner "2. Version negotiation: the same call WITHOUT the A2A-Version header"
curl -s -X POST "$AGENT/" -H "$J" -d '{
  "jsonrpc":"2.0","id":1,"method":"SendMessage",
  "params":{"message":{"messageId":"raw-nover","role":"ROLE_USER",
    "parts":[{"text":"hello","mediaType":"text/plain"}]}}}' | jq_or_cat

banner "3. SendMessage — a blocking call that returns the whole Task"
TASK_JSON=$(curl -s -X POST "$AGENT/" -H "$J" -H "$V" -d '{
  "jsonrpc":"2.0","id":2,"method":"SendMessage",
  "params":{"message":{"messageId":"raw-1","role":"ROLE_USER",
    "parts":[{"text":"Plain JSON-RPC over HTTP. No SDK involved.","mediaType":"text/plain"}]}}}')
echo "$TASK_JSON" | jq_or_cat
TASK_ID=$(echo "$TASK_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["task"]["id"])')

banner "4. SendStreamingMessage — SSE, frames arrive as they are produced"
# -N disables buffering, without it the stream is invisible
curl -sN -X POST "$AGENT/" -H "$J" -H "$V" -H 'Accept: text/event-stream' -d '{
  "jsonrpc":"2.0","id":3,"method":"SendStreamingMessage",
  "params":{"message":{"messageId":"raw-2","role":"ROLE_USER",
    "parts":[{"text":"Every SSE frame is a full JSON-RPC response carrying the same id.","mediaType":"text/plain"}]}}}'

banner "5. GetTask — the task outlived the call and still sits on the server"
curl -s -X POST "$AGENT/" -H "$J" -H "$V" -d "{
  \"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"GetTask\",
  \"params\":{\"id\":\"$TASK_ID\"}}" | jq_or_cat
