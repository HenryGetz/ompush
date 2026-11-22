import { describe, test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  buildT3DeepLink,
  parseT3Lineage,
  queryT3Lineage,
  queryT3Session,
  t3DatabasePath,
  t3EnvironmentId,
  t3SessionDeepLink,
  t3SessionInfo,
  t3SessionLineage,
} from "./t3";

const SUBAGENT_SESSION = "/home/u/.omp/agent/sessions/-ai-t3/child_01.jsonl";
const TOP_LEVEL_SESSION = "/home/u/.omp/agent/sessions/-ai-t3/parent_01.jsonl";
const TOP_LEVEL_THREAD = "thread:parent%01";

function makeT3Database(environmentId?: string): {
  directory: string;
  t3Home: string;
  databasePath: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ompush-t3-"));
  const userdata = path.join(directory, "userdata");
  fs.mkdirSync(userdata, { recursive: true });
  if (environmentId !== undefined) {
    fs.writeFileSync(path.join(userdata, "environment-id"), environmentId);
  }
  const databasePath = path.join(userdata, "statev2.sqlite");
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
    .run(
      "thread-child",
      JSON.stringify({
        title: "Child thread",
        lineage: { relationshipToParent: "subagent" },
      }),
    );
  database
    .prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)")
    .run(
      TOP_LEVEL_THREAD,
      JSON.stringify({
        title: "Parent thread",
        lineage: { relationshipToParent: null },
      }),
    );
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
      TOP_LEVEL_THREAD,
      JSON.stringify({ nativeThreadRef: { nativeId: TOP_LEVEL_SESSION } }),
    );
  database.close();
  return { directory, t3Home: directory, databasePath };
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

describe("t3EnvironmentId", () => {
  test("reads and trims the environment id", () => {
    const { directory, t3Home } = makeT3Database("  env-abc  \n");
    try {
      expect(t3EnvironmentId(t3Home)).toBe("env-abc");
      expect(t3EnvironmentId(directory)).toBe("env-abc");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a missing or blank home", () => {
    expect(t3EnvironmentId(undefined)).toBeNull();
    expect(t3EnvironmentId("   ")).toBeNull();
  });

  test("rejects a missing, blank, or unusable file", () => {
    const { directory } = makeT3Database();
    const blank = fs.mkdtempSync(path.join(os.tmpdir(), "ompush-t3-env-"));
    const whitespace = fs.mkdtempSync(path.join(os.tmpdir(), "ompush-t3-env-"));
    const huge = fs.mkdtempSync(path.join(os.tmpdir(), "ompush-t3-env-"));
    try {
      expect(t3EnvironmentId(directory)).toBeNull();
      fs.mkdirSync(path.join(blank, "userdata"), { recursive: true });
      fs.writeFileSync(path.join(blank, "userdata", "environment-id"), "  \n\t");
      expect(t3EnvironmentId(blank)).toBeNull();
      fs.mkdirSync(path.join(whitespace, "userdata"), { recursive: true });
      fs.writeFileSync(path.join(whitespace, "userdata", "environment-id"), "env id");
      expect(t3EnvironmentId(whitespace)).toBeNull();
      fs.mkdirSync(path.join(huge, "userdata"), { recursive: true });
      fs.writeFileSync(path.join(huge, "userdata", "environment-id"), "a".repeat(513));
      expect(t3EnvironmentId(huge)).toBeNull();
    } finally {
      for (const temp of [directory, blank, whitespace, huge]) {
        fs.rmSync(temp, { recursive: true, force: true });
      }
    }
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

describe("queryT3Session", () => {
  test("reads lineage, thread id, and title for a top-level transcript", () => {
    const { directory, databasePath } = makeT3Database();
    try {
      expect(queryT3Session({ databasePath, sessionFile: TOP_LEVEL_SESSION })).toEqual({
        lineage: "top-level",
        threadId: TOP_LEVEL_THREAD,
        title: "Parent thread",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("marks a delegated child transcript", () => {
    const { directory, databasePath } = makeT3Database();
    try {
      expect(queryT3Session({ databasePath, sessionFile: SUBAGENT_SESSION })).toEqual({
        lineage: "subagent",
        threadId: "thread-child",
        title: "Child thread",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports an unknown shape for an unread transcript or missing database", () => {
    const { directory, databasePath } = makeT3Database();
    try {
      expect(
        queryT3Session({
          databasePath,
          sessionFile: "/home/u/.omp/agent/sessions/-ai-t3/none.jsonl",
        }),
      ).toEqual({ lineage: "unknown", threadId: null, title: null });
      expect(
        queryT3Session({
          databasePath: path.join(os.tmpdir(), "ompush-t3-missing", "statev2.sqlite"),
          sessionFile: TOP_LEVEL_SESSION,
        }),
      ).toEqual({ lineage: "unknown", threadId: null, title: null });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
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

describe("t3SessionInfo", () => {
  test("combines the database path and transcript lookup", () => {
    const { directory, t3Home } = makeT3Database("env-abc");
    try {
      expect(t3SessionInfo({ t3Home, sessionFile: TOP_LEVEL_SESSION })).toEqual({
        lineage: "top-level",
        threadId: TOP_LEVEL_THREAD,
        title: "Parent thread",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("requires both a T3 home and a transcript", () => {
    expect(t3SessionInfo({ t3Home: undefined, sessionFile: TOP_LEVEL_SESSION })).toEqual({
      lineage: "unknown",
      threadId: null,
      title: null,
    });
    expect(t3SessionInfo({ t3Home: "/home/u/.t3", sessionFile: undefined })).toEqual({
      lineage: "unknown",
      threadId: null,
      title: null,
    });
  });
});

describe("t3SessionLineage", () => {
  test("requires both a T3 home and a transcript", () => {
    expect(t3SessionLineage({ t3Home: undefined, sessionFile: SUBAGENT_SESSION })).toBe("unknown");
    expect(t3SessionLineage({ t3Home: "/home/u/.t3", sessionFile: undefined })).toBe("unknown");
  });
});

describe("buildT3DeepLink", () => {
  test("builds a deep link and percent-encodes both segments", () => {
    expect(
      buildT3DeepLink({
        environmentId: "env:1",
        threadId: "thread:parent%01",
      }),
    ).toBe("t3code://threads/env%3A1/thread%3Aparent%2501");
  });

  test("accepts a custom scheme", () => {
    expect(
      buildT3DeepLink({
        scheme: "ompush",
        environmentId: "env-abc",
        threadId: "thread-1",
      }),
    ).toBe("ompush://threads/env-abc/thread-1");
  });

  test("rejects blank ids and invalid schemes", () => {
    expect(buildT3DeepLink({ environmentId: "  ", threadId: "thread-1" })).toBeNull();
    expect(buildT3DeepLink({ environmentId: "env-abc", threadId: "  " })).toBeNull();
    expect(buildT3DeepLink({ environmentId: null, threadId: "thread-1" })).toBeNull();
    expect(buildT3DeepLink({ environmentId: "env-abc", threadId: undefined })).toBeNull();
    expect(
      buildT3DeepLink({ scheme: "1bad", environmentId: "env-abc", threadId: "thread-1" }),
    ).toBeNull();
    expect(
      buildT3DeepLink({ scheme: "bad scheme", environmentId: "env-abc", threadId: "thread-1" }),
    ).toBeNull();
  });
});

describe("t3SessionDeepLink", () => {
  test("builds a link from the transcript's top-level thread", () => {
    const { directory, t3Home } = makeT3Database("env-abc");
    try {
      expect(t3SessionDeepLink({ t3Home, sessionFile: TOP_LEVEL_SESSION })).toBe(
        "t3code://threads/env-abc/thread%3Aparent%2501",
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("prefers an explicit thread id and honors a custom scheme", () => {
    const { directory, t3Home } = makeT3Database("env-abc");
    try {
      expect(
        t3SessionDeepLink({
          t3Home,
          sessionFile: TOP_LEVEL_SESSION,
          threadId: "other:thread%02",
          scheme: "ompush",
        }),
      ).toBe("ompush://threads/env-abc/other%3Athread%2502");
      expect(
        t3SessionDeepLink({ t3Home, sessionFile: undefined, threadId: "other-thread" }),
      ).toBe("t3code://threads/env-abc/other-thread");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("returns null for a delegated child", () => {
    const { directory, t3Home } = makeT3Database("env-abc");
    try {
      expect(t3SessionDeepLink({ t3Home, sessionFile: SUBAGENT_SESSION })).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("returns null without an environment id or a thread id", () => {
    const missingEnv = makeT3Database();
    try {
      expect(
        t3SessionDeepLink({ t3Home: missingEnv.t3Home, sessionFile: TOP_LEVEL_SESSION }),
      ).toBeNull();
    } finally {
      fs.rmSync(missingEnv.directory, { recursive: true, force: true });
    }

    const { directory, t3Home } = makeT3Database("env-abc");
    try {
      expect(t3SessionDeepLink({ t3Home, sessionFile: undefined })).toBeNull();
      expect(
        t3SessionDeepLink({
          t3Home,
          sessionFile: "/home/u/.omp/agent/sessions/-ai-t3/none.jsonl",
        }),
      ).toBeNull();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
