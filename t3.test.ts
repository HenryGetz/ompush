import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { parseT3Lineage, queryT3Lineage, t3DatabasePath, t3SessionLineage } from "./t3";

const SUBAGENT_SESSION = "/home/u/.omp/agent/sessions/-ai-t3/child_01.jsonl";
const TOP_LEVEL_SESSION = "/home/u/.omp/agent/sessions/-ai-t3/parent_01.jsonl";

function makeT3Database(): { directory: string; databasePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ompush-t3-"));
  const databasePath = path.join(directory, "statev2.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE orchestration_v2_projection_threads (
      thread_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  database
    .prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)")
    .run("thread-child", JSON.stringify({ lineage: { relationshipToParent: "subagent" } }));
  database
    .prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)")
    .run("thread-parent", JSON.stringify({ lineage: { relationshipToParent: null } }));
  database
    .prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)")
    .run(
      "provider-child",
      "thread-child",
      JSON.stringify({ nativeThreadRef: { nativeId: SUBAGENT_SESSION } }),
    );
  database
    .prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)")
    .run(
      "provider-parent",
      "thread-parent",
      JSON.stringify({ nativeThreadRef: { nativeId: TOP_LEVEL_SESSION } }),
    );
  database.close();
  return { directory, databasePath };
}

describe("t3DatabasePath", () => {
  test("joins the state database under a T3 home", () => {
    expect(t3DatabasePath("/home/u/.t3")).toBe("/home/u/.t3/userdata/statev2.sqlite");
  });

  test("rejects a missing or blank home", () => {
    expect(t3DatabasePath(undefined)).toBeNull();
    expect(t3DatabasePath("   ")).toBeNull();
  });
});

describe("parseT3Lineage", () => {
  test("recognizes a delegated child", () => {
    expect(parseT3Lineage({ relationship: "subagent" })).toBe("subagent");
  });

  test("treats a top-level or unreadable row as top-level", () => {
    expect(parseT3Lineage({ relationship: null })).toBe("top-level");
    expect(parseT3Lineage({})).toBe("top-level");
  });

  test("reports no row as unknown", () => {
    expect(parseT3Lineage(null)).toBe("unknown");
    expect(parseT3Lineage(undefined)).toBe("unknown");
  });
});

describe("queryT3Lineage", () => {
  test("separates delegated children from top-level threads", () => {
    const { directory, databasePath } = makeT3Database();
    try {
      expect(queryT3Lineage({ databasePath, sessionFile: SUBAGENT_SESSION })).toBe("subagent");
      expect(queryT3Lineage({ databasePath, sessionFile: TOP_LEVEL_SESSION })).toBe("top-level");
      expect(
        queryT3Lineage({ databasePath, sessionFile: "/home/u/.omp/agent/sessions/-ai-t3/none.jsonl" }),
      ).toBe("unknown");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails open when the database is absent", () => {
    expect(
      queryT3Lineage({
        databasePath: path.join(os.tmpdir(), "ompush-t3-missing", "statev2.sqlite"),
        sessionFile: SUBAGENT_SESSION,
      }),
    ).toBe("unknown");
  });
});

describe("t3SessionLineage", () => {
  test("requires both a T3 home and a transcript", () => {
    expect(t3SessionLineage({ t3Home: undefined, sessionFile: SUBAGENT_SESSION })).toBe("unknown");
    expect(t3SessionLineage({ t3Home: "/home/u/.t3", sessionFile: undefined })).toBe("unknown");
  });
});
