import { describe, test, expect } from "bun:test";
import {
  MESSAGE_CAP,
  LAST_TEXT_CAP,
  PREVIEW_CAP,
  resolveCredentials,
  parseGitBranch,
  formatDetachedHead,
  formatContext,
  truncateEnd,
  toolPreview,
  fingerprint,
  buildNotification,
  decideDone,
  decideBlocked,
  encodeForm,
  buildFormBody,
} from "./lib";

// Dummy credential literals only (USER1234 / TOK5678) — never real secrets.

const ENV_FILE_FULL =
  "# pushover creds\n\nexport PUSHOVER_USER='FILEUSER'\nPUSHOVER_TOKEN=\"TOK5678\"\n";

describe("resolveCredentials", () => {
  test("full env pair wins over envFile and json", () => {
    const r = resolveCredentials({
      env: { PUSHOVER_USER: "USER1234", PUSHOVER_TOKEN: "TOK5678" },
      envFileContent: "PUSHOVER_USER=OTHER99\nPUSHOVER_TOKEN=OTHER88\n",
      jsonContent: '{"pushover":{"userKey":"JSONUSER","token":"JSONTOK"}}',
    });
    expect(r).toEqual({ user: "USER1234", token: "TOK5678", source: "env" });
  });

  test("partial env pair falls through to a full envFile pair", () => {
    const r = resolveCredentials({
      env: { PUSHOVER_USER: "USER1234" },
      envFileContent: ENV_FILE_FULL,
      jsonContent: '{"pushover":{"userKey":"JSONUSER","token":"JSONTOK"}}',
    });
    expect(r).toEqual({ user: "FILEUSER", token: "TOK5678", source: "envFile" });
  });

  test("envFile tolerates export prefix, quotes, comments, blank lines", () => {
    const r = resolveCredentials({ env: {}, envFileContent: ENV_FILE_FULL });
    expect(r).toEqual({ user: "FILEUSER", token: "TOK5678", source: "envFile" });
  });

  test("partial env and envFile fall through to the JSON pair", () => {
    const r = resolveCredentials({
      env: { PUSHOVER_USER: "USER1234" },
      envFileContent: "PUSHOVER_TOKEN=TOK5678\n",
      jsonContent: '{"pushover":{"userKey":"USER1234","token":"TOK5678"}}',
    });
    expect(r).toEqual({ user: "USER1234", token: "TOK5678", source: "json" });
  });

  test("all sources missing yields null", () => {
    expect(resolveCredentials({ env: {}, envFileContent: "", jsonContent: "" })).toBeNull();
  });

  test("all sources partial yields null (pair-level resolution)", () => {
    const r = resolveCredentials({
      env: { PUSHOVER_USER: "USER1234" },
      envFileContent: "PUSHOVER_USER=ONLYUSER\n",
      jsonContent: '{"pushover":{"userKey":"JSONUSER"}}',
    });
    expect(r).toBeNull();
  });

  test("malformed JSON falls through to null instead of throwing", () => {
    const r = resolveCredentials({
      env: { PUSHOVER_USER: "USER1234" },
      envFileContent: "PUSHOVER_TOKEN=TOK5678\n",
      jsonContent: "{not valid json",
    });
    expect(r).toBeNull();
  });
});

describe("parseGitBranch / formatDetachedHead", () => {
  test("clean branch name", () => {
    expect(parseGitBranch("main\n", 0)).toBe("main");
  });

  test("branch name is trimmed", () => {
    expect(parseGitBranch("  feature/x  \n", 0)).toBe("feature/x");
  });

  test("HEAD output marks a detached checkout", () => {
    expect(parseGitBranch("HEAD\n", 0)).toBeNull();
  });

  test("non-repo exit code yields no branch", () => {
    expect(parseGitBranch("", 128)).toBeNull();
  });

  test("detached head gets a sha marker", () => {
    expect(formatDetachedHead("abc1234\n")).toBe("detached@abc1234");
  });

  test("detached head without sha stays bare", () => {
    expect(formatDetachedHead("")).toBe("detached");
  });
});

describe("formatContext", () => {
  test("Herdr context uses workspace and pane ids", () => {
    expect(
      formatContext({
        isHerdr: true,
        workspaceId: "w1",
        paneId: "w1:p1",
        cwd: "/home/wavy/myproj",
      }),
    ).toBe("Herdr · ws w1 · pane w1:p1");
  });

  test("Herdr context with missing ids shows placeholders", () => {
    expect(formatContext({ isHerdr: true, cwd: "/home/wavy/myproj" })).toBe(
      "Herdr · ws ? · pane ?",
    );
  });

  test("standalone context includes project and branch", () => {
    expect(
      formatContext({ isHerdr: false, cwd: "/home/wavy/myproj", branch: "feature/x" }),
    ).toBe("Standalone · myproj · feature/x");
  });

  test("standalone context omits branch without a dangling separator", () => {
    expect(formatContext({ isHerdr: false, cwd: "/home/wavy/myproj", branch: null })).toBe(
      "Standalone · myproj",
    );
  });
});

describe("truncateEnd", () => {
  test("short text is unchanged", () => {
    expect(truncateEnd("short", 10)).toBe("short");
  });

  test("long text keeps the head and ends with exactly ...", () => {
    const out = truncateEnd("a".repeat(50), 10);
    expect(out.length).toBe(10);
    expect(out).toBe("a".repeat(7) + "...");
  });

  test("max 3 edge falls back to a raw slice without the indicator", () => {
    expect(truncateEnd("abcdef", 3)).toBe("abc");
  });

  test("max 4 is the smallest truncation that gets the indicator", () => {
    expect(truncateEnd("abcdef", 4)).toBe("a...");
  });
});

describe("toolPreview", () => {
  test("bash tool args render their command", () => {
    expect(toolPreview({ toolName: "bash", command: "rm -rf /tmp/x" })).toBe("rm -rf /tmp/x");
  });

  test("path-based tool args render the path", () => {
    expect(toolPreview({ path: "/etc/hosts" })).toBe("/etc/hosts");
  });

  test("secret values in commands are masked", () => {
    const out = toolPreview({ command: "export AWS_SECRET_ACCESS_KEY=SuperSecret123" });
    expect(out).toContain("AWS_SECRET_ACCESS_KEY=[REDACTED]");
    expect(out).not.toContain("SuperSecret123");
  });

  test("long previews are capped at PREVIEW_CAP with a ... tail", () => {
    const out = toolPreview({ command: "x".repeat(PREVIEW_CAP + 50) });
    expect(out.length).toBe(PREVIEW_CAP);
    expect(out.endsWith("...")).toBe(true);
    expect(out.startsWith("x".repeat(10))).toBe(true);
  });

  test("unusable inputs render as unknown input", () => {
    expect(toolPreview(null)).toBe("unknown input");
    expect(toolPreview(42)).toBe("unknown input");
    expect(toolPreview({})).toBe("unknown input");
  });
});

describe("buildNotification", () => {
  const CONTEXT = "Standalone · myproj · feature/x";

  test("done notification carries elapsed and context", () => {
    const n = buildNotification({
      kind: "done",
      project: "myproj",
      lastText: "hello world",
      elapsedMs: 65000,
      contextLine: CONTEXT,
    });
    expect(n.title).toBe(`[complete] myproj`);
    expect(n.priority).toBe(0);
    expect(n.sound).toBeUndefined();
    expect(n.message).toBe(`hello world (elapsed: 1m 5s)\n\n${CONTEXT}`);
    expect(n.message.length).toBeLessThanOrEqual(MESSAGE_CAP);
  });

  test("long last assistant text is cut at LAST_TEXT_CAP", () => {
    const n = buildNotification({
      kind: "done",
      project: "myproj",
      lastText: "a".repeat(LAST_TEXT_CAP + 200),
      elapsedMs: 0,
      contextLine: "Standalone · myproj",
    });
    expect(n.message.startsWith("a".repeat(LAST_TEXT_CAP - 3) + "...")).toBe(true);
    expect(n.message).not.toContain("a".repeat(LAST_TEXT_CAP));
    expect(n.message.length).toBeLessThanOrEqual(MESSAGE_CAP);
  });

  test("whole done message is capped at MESSAGE_CAP", () => {
    const n = buildNotification({
      kind: "done",
      project: "myproj",
      lastText: "x",
      elapsedMs: 0,
      contextLine: "c".repeat(MESSAGE_CAP),
    });
    expect(n.message.length).toBeLessThanOrEqual(MESSAGE_CAP);
  });

  test("title is capped at 250 chars", () => {
    const n = buildNotification({
      kind: "done",
      project: "p".repeat(400),
      lastText: "hi",
      elapsedMs: 0,
      contextLine: "ctx",
    });
    expect(n.title.length).toBeLessThanOrEqual(250);
  });

  test("blocked notification is urgent with siren and preview", () => {
    const n = buildNotification({
      kind: "blocked",
      project: "myproj",
      toolName: "bash",
      preview: "rm -rf /tmp/x",
      contextLine: "Standalone · myproj",
    });
    expect(n.title).toBe(`[blocked] myproj`);
    expect(n.priority).toBe(1);
    expect(n.sound).toBe("siren");
    expect(n.message).toBe("Needs approval: bash\nrm -rf /tmp/x\n\nStandalone · myproj");
    expect(n.message.length).toBeLessThanOrEqual(MESSAGE_CAP);
  });

  test("blocked message includes the reason above the preview", () => {
    const n = buildNotification({
      kind: "blocked",
      project: "myproj",
      toolName: "bash",
      reason: "wipes a directory",
      preview: "rm -rf /tmp/x",
      contextLine: "Standalone · myproj",
    });
    expect(n.message).toBe(
      "Needs approval: bash\nwipes a directory\nrm -rf /tmp/x\n\nStandalone · myproj",
    );
  });

  test("blocked message without preview or reason keeps its shape", () => {
    const n = buildNotification({
      kind: "blocked",
      project: "myproj",
      toolName: "bash",
      contextLine: "Standalone · myproj",
    });
    expect(n.message).toBe("Needs approval: bash\n\nStandalone · myproj");
  });
});

describe("fingerprint", () => {
  test("is stable, short and hex", () => {
    const f = fingerprint("titlemessage");
    expect(f).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint("titlemessage")).toBe(f);
  });

  test("different inputs produce different fingerprints", () => {
    expect(fingerprint("alpha")).not.toBe(fingerprint("beta"));
  });
});

describe("decideDone", () => {
  const base = {
    isTopLevel: true,
    willContinue: false,
    busyJobs: 0,
    pendingHold: false,
    fingerprint: "fp1",
    nowMs: 100000,
    lastSent: null,
  };

  test("continuation settles are skipped", () => {
    expect(decideDone({ ...base, willContinue: true })).toEqual({
      action: "skip",
      reason: "continuation",
    });
  });

  test("nested or subagent sessions are skipped", () => {
    const d = decideDone({ ...base, isTopLevel: false });
    expect(d.action).toBe("skip");
    expect((d.reason ?? "").startsWith("subagent-or-nested")).toBe(true);
  });

  test("running async jobs hold the notification", () => {
    expect(decideDone({ ...base, busyJobs: 3 })).toEqual({ action: "hold", reason: "busy" });
  });

  test("held notification flushes once quiet", () => {
    expect(decideDone({ ...base, pendingHold: true }).action).toBe("send");
  });

  test("identical fingerprint inside the window is deduped", () => {
    const d = decideDone({ ...base, lastSent: { fingerprint: "fp1", atMs: 95000 } });
    expect(d).toEqual({ action: "skip", reason: "dedupe" });
  });

  test("identical fingerprint after the window sends again", () => {
    const d = decideDone({ ...base, lastSent: { fingerprint: "fp1", atMs: 80000 } });
    expect(d.action).toBe("send");
  });

  test("a fresh fingerprint sends even right after the last one", () => {
    const d = decideDone({ ...base, lastSent: { fingerprint: "other", atMs: 99000 } });
    expect(d.action).toBe("send");
  });
});

describe("decideBlocked", () => {
  const base = {
    isTopLevel: true,
    crossSession: false,
    fingerprint: "fp1",
    nowMs: 100000,
    lastBlocked: null,
  };

  test("nested or subagent sessions are skipped", () => {
    const d = decideBlocked({ ...base, isTopLevel: false });
    expect(d.action).toBe("skip");
    expect((d.reason ?? "").startsWith("subagent-or-nested")).toBe(true);
  });

  test("cross-session approvals are skipped", () => {
    expect(decideBlocked({ ...base, crossSession: true })).toEqual({
      action: "skip",
      reason: "cross-session",
    });
  });

  test("same fingerprint recently seen is deduped", () => {
    const d = decideBlocked({ ...base, lastBlocked: { fingerprint: "fp1", atMs: 90000 } });
    expect(d).toEqual({ action: "skip", reason: "dedupe" });
  });

  test("flapping blocks are debounced", () => {
    const d = decideBlocked({ ...base, lastBlocked: { fingerprint: "fp2", atMs: 95000 } });
    expect(d).toEqual({ action: "skip", reason: "debounce" });
  });

  test("a different block after the gap sends", () => {
    const d = decideBlocked({ ...base, lastBlocked: { fingerprint: "fp2", atMs: 70000 } });
    expect(d.action).toBe("send");
  });
});

describe("encodeForm", () => {
  test("percent-encodes UTF-8 bytes with uppercase hex", () => {
    expect(encodeForm([["t", "a b&c=dé"]])).toBe("t=a%20b%26c%3Dd%C3%A9");
  });

  test("empty values are kept as bare keys", () => {
    expect(encodeForm([["k", ""]])).toBe("k=");
  });

  test("pairs join with &", () => {
    expect(
      encodeForm([
        ["a", "1"],
        ["b", "2"],
      ]),
    ).toBe("a=1&b=2");
  });
});

describe("buildFormBody", () => {
  const creds = { user: "USER1234", token: "TOK5678", source: "env" as const };
  const enc = (s: string) => encodeForm([["v", s]]).slice(2);

  test("blocked body carries creds, encoded fields, priority and sound", () => {
    const n = buildNotification({
      kind: "blocked",
      project: "my proj",
      toolName: "bash",
      preview: "rm -rf /tmp/x",
      contextLine: "Standalone · my proj",
    });
    const body = buildFormBody(creds, n);
    expect(body).toContain("token=TOK5678&user=USER1234");
    expect(body).toContain(`title=${enc(n.title)}`);
    expect(body).toContain(`message=${enc(n.message)}`);
    expect(body).toContain("priority=1");
    expect(body).toContain("sound=siren");
  });

  test("done body omits sound and uses default priority", () => {
    const n = buildNotification({
      kind: "done",
      project: "myproj",
      lastText: "all good",
      elapsedMs: 65000,
      contextLine: "Standalone · myproj",
    });
    const body = buildFormBody(creds, n);
    expect(body).toContain("token=TOK5678&user=USER1234");
    expect(body).toContain(`title=${enc(n.title)}`);
    expect(body).toContain(`message=${enc(n.message)}`);
    expect(body).toContain("priority=0");
    expect(body).not.toContain("sound=");
  });
});
