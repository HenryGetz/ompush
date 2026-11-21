// Compatibility guard for ompush sessions that started before T3-child
// suppression: ask T3 which thread owns this process, then read that thread's
// lineage. Exit 0 for a delegated child, 1 for anything uncertain.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const t3Home = process.env.T3CODE_HOME;
const mcpUrl = process.env.T3_MCP_URL;
const token = process.env.T3_MCP_BEARER_TOKEN;
if (!t3Home || !mcpUrl || !token) process.exit(1);

const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const timeout = () => AbortSignal.timeout(5_000);

async function call(body, sessionId) {
  return fetch(mcpUrl, {
    method: "POST",
    headers: sessionId ? { ...headers, "mcp-session-id": sessionId } : headers,
    body: JSON.stringify(body),
    signal: timeout(),
  });
}

async function currentThreadId() {
  const init = await call({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ompush-legacy", version: "1" },
    },
  });
  const sessionId = init.headers.get("mcp-session-id");
  if (!sessionId) return null;
  await call({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId).catch(() => {});
  const response = await call(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "t3_thread_configure", arguments: {} },
    },
    sessionId,
  );
  const json = await response.json();
  const structured = json?.result?.structuredContent;
  if (typeof structured?.threadId === "string") return structured.threadId;
  const text = json?.result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.threadId === "string" ? parsed.threadId : null;
  } catch {
    return null;
  }
}

async function main() {
  const threadId = await currentThreadId();
  if (!threadId) process.exit(1);
  const databasePath = path.join(t3Home, "userdata", "statev2.sqlite");
  if (!fs.existsSync(databasePath)) process.exit(1);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship
         FROM orchestration_v2_projection_threads
         WHERE thread_id = ?
         LIMIT 1`,
      )
      .get(threadId);
    process.exit(row?.relationship === "subagent" ? 0 : 1);
  } finally {
    database.close();
  }
}

main().catch(() => process.exit(1));
