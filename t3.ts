// T3 Code runs every thread as a top-level OMP session, including the threads
// it creates through `delegate_task`. Those children are subagents in T3's
// own thread graph; this helper reads that graph so ompush can stay quiet.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const DEFAULT_SCHEME = "t3code";
const MAX_ENVIRONMENT_ID_LENGTH = 512;
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*$/i;
const UNSAFE_ENVIRONMENT_ID_PATTERN = /[\s\p{Cc}]/u;

export type T3Lineage = "subagent" | "top-level" | "unknown";

export type T3SessionInfo = {
  readonly lineage: T3Lineage;
  readonly threadId: string | null;
  readonly title: string | null;
};

type DatabaseSyncLike = {
  prepare: (sql: string) => { get: (...params: unknown[]) => unknown };
  close: () => void;
};

type SqliteModule = {
  DatabaseSync: new (databasePath: string, options?: { readOnly?: boolean }) => DatabaseSyncLike;
};

const SESSION_QUERY = `
SELECT pt.thread_id AS threadId,
       json_extract(t.payload_json, '$.title') AS title,
       json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship
FROM orchestration_v2_projection_provider_threads AS pt
LEFT JOIN orchestration_v2_projection_threads AS t ON t.thread_id = pt.thread_id
WHERE json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') = ?
LIMIT 1
`;

const UNKNOWN_SESSION: T3SessionInfo = {
  lineage: "unknown",
  threadId: null,
  title: null,
};

export function t3DatabasePath(t3Home: string | undefined): string | null {
  const trimmed = typeof t3Home === "string" ? t3Home.trim() : "";
  if (trimmed.length === 0) return null;
  return path.join(trimmed, "userdata", "statev2.sqlite");
}

/** The environment id mobile clients use in `t3code://threads/<env>/<thread>`. */
export function t3EnvironmentId(t3Home: string | undefined): string | null {
  const trimmed = typeof t3Home === "string" ? t3Home.trim() : "";
  if (trimmed.length === 0) return null;
  try {
    const environmentId = fs
      .readFileSync(path.join(trimmed, "userdata", "environment-id"), "utf8")
      .trim();
    if (environmentId.length === 0 || environmentId.length > MAX_ENVIRONMENT_ID_LENGTH) {
      return null;
    }
    if (UNSAFE_ENVIRONMENT_ID_PATTERN.test(environmentId)) return null;
    return environmentId;
  } catch {
    return null;
  }
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

export function queryT3Session(input: {
  databasePath: string;
  sessionFile: string;
}): T3SessionInfo {
  if (!input.sessionFile || !fs.existsSync(input.databasePath)) return UNKNOWN_SESSION;
  let database: DatabaseSyncLike | undefined;
  try {
    const sqlite = require("node:sqlite") as SqliteModule;
    database = new sqlite.DatabaseSync(input.databasePath, { readOnly: true });
    const row = database.prepare(SESSION_QUERY).get(input.sessionFile);
    if (row === null || row === undefined) return UNKNOWN_SESSION;
    const record = typeof row === "object" ? (row as Record<string, unknown>) : {};
    const threadId =
      typeof record.threadId === "string" && record.threadId.trim().length > 0
        ? record.threadId
        : null;
    const title =
      typeof record.title === "string" && record.title.trim().length > 0 ? record.title : null;
    return { lineage: parseT3Lineage(row), threadId, title };
  } catch {
    return UNKNOWN_SESSION;
  } finally {
    try {
      database?.close();
    } catch {
      // closing a read-only handle cannot change the answer
    }
  }
}

export function queryT3Lineage(input: { databasePath: string; sessionFile: string }): T3Lineage {
  return queryT3Session(input).lineage;
}

export function t3SessionInfo(input: {
  t3Home?: string;
  sessionFile?: string;
}): T3SessionInfo {
  const databasePath = t3DatabasePath(input.t3Home);
  const sessionFile = typeof input.sessionFile === "string" ? input.sessionFile.trim() : "";
  if (databasePath === null || sessionFile.length === 0) return UNKNOWN_SESSION;
  return queryT3Session({ databasePath, sessionFile });
}

export function t3SessionLineage(input: {
  t3Home: string | undefined;
  sessionFile: string | undefined;
}): T3Lineage {
  return t3SessionInfo({ t3Home: input.t3Home, sessionFile: input.sessionFile }).lineage;
}

export function buildT3DeepLink(input: {
  scheme?: string;
  environmentId: string | null | undefined;
  threadId: string | null | undefined;
}): string | null {
  try {
    const scheme =
      typeof input.scheme === "string" && input.scheme.trim().length > 0
        ? input.scheme.trim()
        : DEFAULT_SCHEME;
    if (!SCHEME_PATTERN.test(scheme)) return null;
    const environmentId =
      typeof input.environmentId === "string" ? input.environmentId.trim() : "";
    const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
    if (environmentId.length === 0 || threadId.length === 0) return null;
    return `${scheme}://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  } catch {
    return null;
  }
}

export function t3SessionDeepLink(input: {
  t3Home?: string;
  sessionFile?: string;
  threadId?: string;
  scheme?: string;
}): string | null {
  const info = t3SessionInfo({ t3Home: input.t3Home, sessionFile: input.sessionFile });
  if (info.lineage === "subagent") return null;
  const explicitThreadId =
    typeof input.threadId === "string" ? input.threadId.trim() : "";
  const threadId = explicitThreadId.length > 0 ? explicitThreadId : info.threadId;
  return buildT3DeepLink({
    scheme: input.scheme,
    environmentId: t3EnvironmentId(input.t3Home),
    threadId,
  });
}
