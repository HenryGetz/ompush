import { describe, test, expect } from "bun:test";
import {
  MESSAGE_CAP,
  LAST_TEXT_CAP,
  PREVIEW_CAP,
  resolveCredentials,
  parseGitBranch,
  formatDetachedHead,
  formatContext,
  formatElapsed,
  formatTokens,
  formatCost,
  truncateEnd,
  toolPreview,
  fingerprint,
  buildNotification,
  turnStats,
  isAbortedTurn,
  lastErrorMessage,
  decideDone,
  decideBlocked,
  encodeForm,
  buildFormBody,
  extractQuestionTopic,
  formatQuestionOptions,
  parseAskInput,
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
  test("renders question text and options when input is from ask tool", () => {
    const input = {
      questions: [
        {
          question: "Which authentication method?",
          options: [{ label: "JWT" }, { label: "OAuth2" }, { label: "Session cookies" }],
        },
      ],
    };
    expect(toolPreview(input)).toBe("Which authentication method?\n› JWT  ·  OAuth2  ·  Session cookies");
  });

  test("renders simple question string input", () => {
    expect(toolPreview({ question: "Continue with migration?" })).toBe("Continue with migration?");
  });
});

describe("formatElapsed", () => {
  test("minutes and seconds", () => {
    expect(formatElapsed(252_000)).toBe("4m 12s");
  });

  test("seconds only below a minute", () => {
    expect(formatElapsed(45_000)).toBe("45s");
  });

  test("hours and minutes drop the seconds", () => {
    expect(formatElapsed(3_780_000)).toBe("1h 3m");
  });

  test("zero renders as 0s", () => {
    expect(formatElapsed(0)).toBe("0s");
  });

  test("negative input clamps to 0s", () => {
    expect(formatElapsed(-5_000)).toBe("0s");
  });
});

describe("formatTokens", () => {
  test("below a thousand stays plain", () => {
    expect(formatTokens(999)).toBe("999");
  });

  test("thousands get a trimmed k suffix", () => {
    expect(formatTokens(18_400)).toBe("18.4k");
    expect(formatTokens(20_000)).toBe("20k");
  });

  test("millions get a trimmed M suffix", () => {
    expect(formatTokens(1_240_000)).toBe("1.2M");
  });
});

describe("formatCost", () => {
  test("cents below a dollar, dollars above, dollars as fallback", () => {
    expect(formatCost(0.04)).toBe("4¢");
    expect(formatCost(0)).toBe("0¢");
    expect(formatCost(0.0002)).toBe("0.02¢");
    expect(formatCost(0.4567)).toBe("45.7¢");
    expect(formatCost(0.999)).toBe("99.9¢");
    expect(formatCost(1)).toBe("$1.00");
    expect(formatCost(12.5)).toBe("$12.50");
    expect(formatCost(0.9999)).toBe("$1.00");
  });

  test("prepends ⓠ when spending quota/subscription", () => {
    expect(formatCost(0.00614, true)).toBe("ⓠ0.61¢");
    expect(formatCost(0.04, true)).toBe("ⓠ4¢");
    expect(formatCost(0, true)).toBe("ⓠ0¢");
    expect(formatCost(0.0002, true)).toBe("ⓠ0.02¢");
    expect(formatCost(1.25, true)).toBe("ⓠ$1.25");
  });
});

describe("buildNotification", () => {
  const CONTEXT = "Standalone · myproj · feature/x";

  test("reference example is byte-exact", () => {
    const n = buildNotification({
      kind: "done",
      project: "zachhudson",
      contextLine: "Standalone · zachhudson · main",
      lastText: "ran the suite",
      elapsedMs: 252_000,
      tokens: 18_400,
      costUsd: 0.04,
    });
    expect(n.title).toBe("zachhudson · ✓4m 12s · 18.4k · 4¢");
    expect(n.priority).toBe(0);
    expect(n.sound).toBeUndefined();
    expect(n.message.length).toBeLessThanOrEqual(MESSAGE_CAP);
  });
  test("done notification with quota cost carries ⓠ prefix", () => {
    const n = buildNotification({
      kind: "done",
      project: "zachhudson",
      contextLine: "Standalone · zachhudson · main",
      lastText: "done",
      elapsedMs: 252_000,
      tokens: 18_400,
      costUsd: 0.00614,
      isQuota: true,
    });
    expect(n.title).toBe("zachhudson · ✓4m 12s · 18.4k · ⓠ0.61¢");
  });

  test("done body is exactly the text plus context — no status prefix, no elapsed suffix", () => {
    const n = buildNotification({
      kind: "done",
      project: "myproj",
      lastText: "hello world",
      elapsedMs: 65_000,
      contextLine: CONTEXT,
    });
    expect(n.message).toBe(`hello world\n\n${CONTEXT}`);
  });

  test("done with an error uses the cross icon and prefers the error message", () => {
    const n = buildNotification({
      kind: "done",
      project: "myproj",
      lastText: "hello world",
      errorMessage: "it exploded",
      elapsedMs: 65_000,
      contextLine: CONTEXT,
    });
    expect(n.title).toBe("myproj · ❌1m 5s");
    expect(n.message).toBe(`it exploded\n\n${CONTEXT}`);
  });

  test("done without usage shows only project, icon and elapsed", () => {
    const n = buildNotification({
      kind: "done",
      project: "myproj",
      lastText: "hello",
      elapsedMs: 45_000,
      contextLine: CONTEXT,
    });
    expect(n.title).toBe("myproj · ✓45s");
    expect(n.message).toBe(`hello\n\n${CONTEXT}`);
  });

  test("done without text falls back to a generic body", () => {
    const n = buildNotification({ kind: "done", project: "myproj", contextLine: CONTEXT });
    expect(n.title).toBe("myproj · ✓");
    expect(n.message).toBe(`Task completed\n\n${CONTEXT}`);
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

  test("blocked notification is urgent with siren, usage segments and preview", () => {
    const n = buildNotification({
      kind: "blocked",
      project: "myproj",
      toolName: "bash",
      preview: "rm -rf /tmp/x",
      contextLine: "Standalone · myproj",
      elapsedMs: 125_000,
      tokens: 6_100,
      costUsd: 0.02,
    });
    expect(n.title).toBe("myproj · ⚠️2m 5s · 6.1k · 2¢");
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
  test("question notification puts question in title with 💬 and clean choices in body", () => {
    const n = buildNotification({
      kind: "blocked",
      project: "zachhudson",
      toolName: "ask",
      topic: "Database preference",
      question: "Which database do you prefer?",
      options: ["PostgreSQL", "SQLite", "Other (type your own)"],
      contextLine: "Herdr · ws w1 · pane w1:p3",
    });
    expect(n.title).toBe("zachhudson · 💬 Which database do you prefer?");
    expect(n.message).toBe("› PostgreSQL  ·  SQLite\n\nHerdr · ws w1 · pane w1:p3");
    expect(n.priority).toBe(1);
    expect(n.sound).toBe("siren");
  });

  test("free-form question without choices has question in title and context in body", () => {
    const n = buildNotification({
      kind: "blocked",
      project: "librequote",
      toolName: "ask",
      topic: "Target output format",
      question: "Should the generated quote include the B-rep surface breakdown?",
      options: [],
      contextLine: "Herdr · ws w1 · pane w1:p3",
    });
    expect(n.title).toBe("librequote · 💬 Should the generated quote include the B-rep surface breakdown?");
    expect(n.message).toBe("Herdr · ws w1 · pane w1:p3");
    expect(n.priority).toBe(1);
    expect(n.sound).toBe("siren");
  });
});

describe("turnStats", () => {
  test("elapsed runs from the last user message; earlier assistants are ignored", () => {
    const s = turnStats(
      [
        { role: "user", timestamp: 50_000 },
        { role: "assistant", usage: { totalTokens: 9_999, cost: { total: 9.99 } } },
        { role: "user", timestamp: 100_000 },
        { role: "assistant", usage: { totalTokens: 18_400, cost: { total: 0.04 } } },
      ],
      352_000,
    );
    expect(s).toEqual({ elapsedMs: 252_000, tokens: 18_400, costUsd: 0.04 });
  });

  test("falls back to summing the usage fields when totals are missing", () => {
    const s = turnStats(
      [
        { role: "user", timestamp: 0 },
        {
          role: "assistant",
          usage: {
            input: 1_000,
            output: 200,
            cacheRead: 30,
            cacheWrite: 5,
            cost: { input: 0.25, output: 0.125, cacheRead: 0.0625, cacheWrite: 0.0625 },
          },
        },
      ],
      1_000,
    );
    expect(s).toEqual({ elapsedMs: 1_000, tokens: 1_235, costUsd: 0.5 });
  });

  test("totals win over the summed fields", () => {
    const s = turnStats(
      [
        { role: "user", timestamp: 5 },
        { role: "assistant", usage: { totalTokens: 7, input: 100, cost: { total: 0.5, input: 9 } } },
      ],
      5,
    );
    expect(s).toEqual({ elapsedMs: 0, tokens: 7, costUsd: 0.5 });
  });

  test("usage sums across assistant entries of the turn", () => {
    const s = turnStats(
      [
        { role: "user", timestamp: 10 },
        { role: "assistant", usage: { totalTokens: 100, cost: { total: 0.25 } } },
        { role: "assistant", usage: { totalTokens: 50, cost: { total: 0.125 } } },
      ],
      20,
    );
    expect(s).toEqual({ elapsedMs: 10, tokens: 150, costUsd: 0.375 });
  });

  test("no assistant usage omits the usage keys entirely", () => {
    const s = turnStats([{ role: "user", timestamp: 1_000 }], 2_000);
    expect(s).toEqual({ elapsedMs: 1_000 });
    expect("tokens" in s).toBe(false);
    expect("costUsd" in s).toBe(false);
  });

  test("extracts provider from assistant message", () => {
    const s = turnStats(
      [
        { role: "user", timestamp: 10 },
        { role: "assistant", provider: "google-gemini-cli", usage: { totalTokens: 100, cost: { total: 0.25 } } },
      ],
      20,
    );
    expect(s.provider).toBe("google-gemini-cli");
  });

  test("no user message yields zero elapsed and still counts usage", () => {
    const s = turnStats([{ role: "assistant", usage: { totalTokens: 10, cost: { total: 0.5 } } }], 99);
    expect(s).toEqual({ elapsedMs: 0, tokens: 10, costUsd: 0.5 });
  });

  test("defensive over unknown shapes", () => {
    expect(turnStats("nope" as unknown[], 100)).toEqual({ elapsedMs: 0 });
    expect(turnStats([null, 42, { role: "assistant", usage: "x" }], 100)).toEqual({ elapsedMs: 0 });
    expect(turnStats([], Number.NaN)).toEqual({ elapsedMs: 0 });
  });
});

describe("lastErrorMessage", () => {
  test("returns the most recent assistant error message", () => {
    expect(
      lastErrorMessage([
        { role: "assistant", stopReason: "error", errorMessage: "first" },
        { role: "assistant", stopReason: "error", errorMessage: "second" },
      ]),
    ).toBe("second");
  });

  test("ignores non-assistant entries, non-error stops and empty messages", () => {
    expect(
      lastErrorMessage([
        { role: "user", stopReason: "error", errorMessage: "user noise" },
        { role: "assistant", stopReason: "stop", errorMessage: "not an error" },
        { role: "assistant", stopReason: "error", errorMessage: "" },
      ]),
    ).toBeUndefined();
  });

  test("undefined for empty or unknown shapes", () => {
    expect(lastErrorMessage([])).toBeUndefined();
    expect(lastErrorMessage("nope" as unknown[])).toBeUndefined();
  });
});

describe("isAbortedTurn", () => {
  test("returns true when last assistant has stopReason aborted", () => {
    expect(isAbortedTurn([{ role: "user" }, { role: "assistant", stopReason: "aborted" }])).toBe(true);
  });

  test("returns true when error message indicates user interruption", () => {
    expect(
      isAbortedTurn([{ role: "user" }, { role: "assistant", errorMessage: "Interrupted by user" }]),
    ).toBe(true);
  });

  test("returns false when last assistant stopped normally", () => {
    expect(isAbortedTurn([{ role: "user" }, { role: "assistant", stopReason: "stop" }])).toBe(false);
  });

  test("returns false for non-assistant or empty messages", () => {
    expect(isAbortedTurn([])).toBe(false);
    expect(isAbortedTurn([{ role: "user" }])).toBe(false);
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

  test("aborted turns are skipped", () => {
    expect(decideDone({ ...base, isAborted: true })).toEqual({ action: "skip", reason: "aborted" });
  });
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
      tokens: 18_400,
      costUsd: 0.04,
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

describe("extractQuestionTopic / parseAskInput", () => {
  test("header takes precedence", () => {
    expect(
      extractQuestionTopic({
        header: "Database preference",
        intent: "Asking database preference",
        id: "database",
      }),
    ).toBe("Database preference");
  });

  test("intent prefix is stripped and capitalized", () => {
    expect(extractQuestionTopic({ intent: "Asking database preference" })).toBe("Database preference");
    expect(extractQuestionTopic({ intent: "Asking for target output format" })).toBe("Target output format");
    expect(extractQuestionTopic({ intent: "Ask user about preferred database" })).toBe("Preferred database");
  });

  test("id is formatted when no header or intent", () => {
    expect(extractQuestionTopic({ id: "database_preference" })).toBe("Database preference");
    expect(extractQuestionTopic({ id: "target_output_format" })).toBe("Target output format");
  });

  test("parseAskInput extracts question, topic and options", () => {
    const parsed = parseAskInput({
      questions: [
        {
          id: "database",
          question: "Which database do you prefer?",
          options: [{ label: "PostgreSQL" }, { label: "SQLite" }, { label: "Other (type your own)" }],
        },
      ],
      intent: "Asking database preference",
    });
    expect(parsed.topic).toBe("Database preference");
    expect(parsed.question).toBe("Which database do you prefer?");
    expect(parsed.options).toEqual(["PostgreSQL", "SQLite", "Other (type your own)"]);
  });
});
