// T3 Code runs every thread as a top-level OMP session, including the threads
// it creates through `delegate_task`. Those children are subagents in T3's
// own thread graph; this helper reads that graph so ompush can stay quiet.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type T3Lineage = "subagent" | "top-level" | "unknown";

type DatabaseSyncLike = {
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
  close: () => void;
};

type SqliteModule = {
  DatabaseSync: new (databasePath: string, options?: { readOnly?: boolean }) => DatabaseSyncLike;
};

const LINEAGE_QUERY = `
SELECT json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship
FROM orchestration_v2_projection_provider_threads AS pt
LEFT JOIN orchestration_v2_projection_threads AS t ON t.thread_id = pt.thread_id
WHERE json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') = ?
LIMIT 1
`;

export function t3DatabasePath(t3Home: string | undefined): string | null {
  const trimmed = typeof t3Home === "string" ? t3Home.trim() : "";
  if (trimmed.length === 0) return null;
  return path.join(trimmed, "userdata", "statev2.sqlite");
}

/** The joined row's `relationship`; anything but a proven child is top-level. */
export function parseT3Lineage(row: unknown): T3Lineage {
  if (row === null || row === undefined) return "unknown";
  if (typeof row === "object" && "relationship" in row) {
    const relationship = row.relationship;
    return relationship === "subagent" ? "subagent" : "top-level";
  }
  return "top-level";
}

export function queryT3Lineage(input: { databasePath: string; sessionFile: string }): T3Lineage {
  if (!input.sessionFile || !fs.existsSync(input.databasePath)) return "unknown";
  let database: DatabaseSyncLike | undefined;
  try {
    const sqlite = require("node:sqlite") as SqliteModule;
    database = new sqlite.DatabaseSync(input.databasePath, { readOnly: true });
    return parseT3Lineage(database.prepare(LINEAGE_QUERY).get(input.sessionFile));
  } catch {
    return "unknown";
  } finally {
    try {
      database?.close();
    } catch {
      // closing a read-only handle cannot change the answer
    }
  }
}

export function t3SessionLineage(input: {
  t3Home: string | undefined;
  sessionFile: string | undefined;
}): T3Lineage {
  const databasePath = t3DatabasePath(input.t3Home);
  const sessionFile = typeof input.sessionFile === "string" ? input.sessionFile.trim() : "";
  if (databasePath === null || sessionFile.length === 0) return "unknown";
  return queryT3Lineage({ databasePath, sessionFile });
}
