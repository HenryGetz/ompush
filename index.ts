import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildFormBody,
  buildNotification,
  decideBlocked,
  decideDone,
  fingerprint,
  formatContext,
  formatDetachedHead,
  lastErrorMessage,
  parseAskInput,
  parseGitBranch,
  resolveCredentials,
  toolPreview,
  turnStats,
  type Credentials,
  type Notification,
} from "./lib";

type CtxLike = {
  cwd?: unknown;
  sessionManager?: {
    getSessionFile?: () => unknown;
    getSessionId?: () => unknown;
    getBranch?: () => unknown;
  } | null;
  getAsyncJobSnapshot?: () => unknown;
} | null | undefined;

type DispatchParts = {
  fingerprint: string;
  traceAction?: "sent" | "flush-shutdown";
  lastText?: string;
  errorMessage?: string;
  elapsedMs?: number;
  tokens?: number;
  costUsd?: number;
  isQuota?: boolean;
  toolName?: string;
  reason?: string;
  preview?: string;
  topic?: string;
  question?: string;
  options?: unknown[];
};

type HeldTurn = {
  lastText: string;
  errorMessage?: string;
  elapsedMs?: number;
  tokens?: number;
  costUsd?: number;
  isQuota?: boolean;
};

const MODULE_DIR = path.dirname(new URL(import.meta.url).pathname);
const DELIVER_SCRIPT = path.join(MODULE_DIR, "deliver.sh");
const ENV_FILE = path.join(os.homedir(), ".config", "pushover", "env");
const JSON_FALLBACK = path.join(os.homedir(), ".config", "opencode", ".everynotify.json");
const STATE_DIR = path.join(os.homedir(), ".local", "state", "omp-pushover");
const TRACE_LOG = path.join(STATE_DIR, "trace.log");
const DELIVERIES_LOG = path.join(STATE_DIR, "deliveries.log");
const PREVIEW_MAP_CAP = 16;
const SENT_BLOCKED_CAP = 8;

let cachedCreds: Credentials | null = null;
let credsResolved = false;
const previewMap = new Map<string, string>();
let lastSentDone: { fingerprint: string; at: number } | undefined;
const sentBlocked: Array<{ fingerprint: string; at: number }> = [];
let pendingHold = false;
let pendingDone: HeldTurn | undefined;
let lastMessages: unknown[] = [];

function trace(entry: {
  kind: string;
  action: string;
  reason?: string;
  fingerprint?: string;
  spawnMs?: number;
}): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const line: Record<string, unknown> = {
      ts: new Date().toISOString(),
      kind: entry.kind,
      action: entry.action,
    };
    if (entry.reason) line.reason = entry.reason;
    if (entry.fingerprint) line.fingerprint = entry.fingerprint;
    if (typeof entry.spawnMs === "number") line.spawnMs = entry.spawnMs;
    fs.appendFileSync(TRACE_LOG, `${JSON.stringify(line)}\n`, "utf-8");
  } catch {
    // tracing is best-effort; never message content, never secrets
  }
}

/** Layered subagent/nested suppression; each failure names its layer for the trace. */
function isTopLevelSession(ctx: CtxLike): { ok: boolean; reason?: string } {
  if (process.env.OMPCODE === "1") return { ok: false, reason: "nested-omp" };
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    if (typeof file === "string" && file.length > 0) {
      const base = path.basename(file);
      if (base.startsWith("__advisor") || !base.includes("_")) {
        return { ok: false, reason: "nested-transcript" };
      }
    }
  } catch {
    // undetermined transcript shape — cannot call it nested
  }
  try {
    const branch = ctx?.sessionManager?.getBranch?.();
    if (Array.isArray(branch)) {
      for (const entry of branch) {
        if ((entry as { type?: unknown } | null)?.type === "session_init") {
          return { ok: false, reason: "subagent-session-init" };
        }
      }
    }
  } catch {
    // undetermined branch — cannot call it nested
  }
  return { ok: true };
}

function resolveCwd(ctx: CtxLike): string {
  try {
    const cwd = ctx?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  } catch {
    // fall through
  }
  return process.cwd();
}
function isQuotaSession(ctx: CtxLike, provider?: string): boolean {
  try {
    const reg = (ctx as Record<string, unknown> | null | undefined)?.modelRegistry as
      | { isUsingOAuth?: (m: unknown) => boolean; authStorage?: { hasOAuth?: (p: string) => boolean } }
      | undefined;
    const model =
      (ctx as Record<string, unknown> | null | undefined)?.model ??
      ((ctx as Record<string, unknown> | null | undefined)?.models as { current?: () => unknown } | undefined)?.current?.();

    if (model && typeof reg?.isUsingOAuth === "function" && reg.isUsingOAuth(model)) {
      return true;
    }
    const modelProvider = (model as { provider?: unknown } | null | undefined)?.provider;
    if (
      typeof modelProvider === "string" &&
      typeof reg?.authStorage?.hasOAuth === "function" &&
      reg.authStorage.hasOAuth(modelProvider)
    ) {
      return true;
    }
    if (
      typeof provider === "string" &&
      typeof reg?.authStorage?.hasOAuth === "function" &&
      reg.authStorage.hasOAuth(provider)
    ) {
      return true;
    }
  } catch {
    // fail-open: quota detection errors must never break notifications
  }
  return false;
}

function countUndelivered(delivery: unknown): number {
  try {
    const d = delivery as { queued?: unknown; delivering?: unknown; pendingJobIds?: unknown } | null | undefined;
    if (!d || typeof d !== "object") return 0;
    const queued = typeof d.queued === "number" && d.queued > 0 ? Math.floor(d.queued) : 0;
    const pending = Array.isArray(d.pendingJobIds) ? d.pendingJobIds.length : 0;
    return Math.max(queued, pending) + (d.delivering === true ? 1 : 0);
  } catch {
    return 0;
  }
}

function lastAssistantText(messages: unknown): string {
  try {
    if (!Array.isArray(messages)) return "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: unknown; content?: unknown } | null;
      if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
      const parts: string[] = [];
      for (const block of m.content) {
        const b = block as { type?: unknown; text?: unknown } | null;
        if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
      }
      return parts.join("\n");
    }
  } catch {
    // fall through to default
  }
  return "";
}

function rememberPreview(id: string, preview: string): void {
  if (previewMap.has(id)) {
    previewMap.set(id, preview);
    return;
  }
  while (previewMap.size >= PREVIEW_MAP_CAP) {
    const oldest = previewMap.keys().next();
    if (oldest.done) break;
    previewMap.delete(oldest.value);
  }
  previewMap.set(id, preview);
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function resolveCredsCached(): Credentials | null {
  if (credsResolved) return cachedCreds;
  credsResolved = true;
  try {
    cachedCreds = resolveCredentials({
      env: process.env as Record<string, string | undefined>,
      envFileContent: readFileSafe(ENV_FILE),
      jsonContent: readFileSafe(JSON_FALLBACK),
    });
  } catch {
    cachedCreds = null;
  }
  return cachedCreds;
}

function runGit(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  const { promise, resolve } = Promise.withResolvers<{ stdout: string; code: number }>();
  try {
    const child = execFile("git", ["-C", cwd, ...args], { timeout: 3000 }, (err, stdout) => {
      const rawCode = (err as { code?: unknown } | null)?.code;
      resolve({
        stdout: typeof stdout === "string" ? stdout : "",
        code: !err ? 0 : typeof rawCode === "number" ? rawCode : 1,
      });
    });
    try {
      child.on("error", () => {});
    } catch {
      // listener attachment must never throw
    }
  } catch {
    resolve({ stdout: "", code: 1 });
  }
  return promise;
}

async function resolveBranch(cwd: string): Promise<string | null> {
  try {
    const first = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const branch = parseGitBranch(first.stdout, first.code);
    if (branch !== null) return branch;
    if (first.code === 0 && first.stdout.trim() === "HEAD") {
      const second = await runGit(["rev-parse", "--short", "HEAD"], cwd);
      return formatDetachedHead(second.stdout);
    }
    return null;
  } catch {
    return null;
  }
}

async function runDispatch(kind: "done" | "blocked", parts: DispatchParts, ctx: CtxLike): Promise<void> {
  const creds = resolveCredsCached();
  if (!creds) {
    trace({ kind, action: "skip", reason: "no-creds", fingerprint: parts.fingerprint });
    return;
  }
  const cwd = resolveCwd(ctx);
  const project = path.basename(cwd);
  const branch = await resolveBranch(cwd);
  const isHerdr =
    process.env.HERDR_ENV === "1" && !!process.env.HERDR_SOCKET_PATH && !!process.env.HERDR_PANE_ID;
  const contextLine = formatContext({
    isHerdr,
    workspaceId: process.env.HERDR_WORKSPACE_ID ?? null,
    paneId: process.env.HERDR_PANE_ID ?? null,
    cwd,
    branch,
  });
  const n: Notification =
    kind === "done"
      ? buildNotification({
          kind: "done",
          project,
          contextLine,
          lastText: parts.lastText ?? "",
          errorMessage: parts.errorMessage,
          elapsedMs: parts.elapsedMs,
          tokens: parts.tokens,
          costUsd: parts.costUsd,
          isQuota: parts.isQuota,
        })
      : buildNotification({
          kind: "blocked",
          project,
          contextLine,
          toolName: parts.toolName ?? "",
          reason: parts.reason,
          preview: parts.preview,
          topic: parts.topic,
          question: parts.question,
          options: parts.options,
          elapsedMs: parts.elapsedMs,
          tokens: parts.tokens,
          costUsd: parts.costUsd,
          isQuota: parts.isQuota,
        });
  const body = buildFormBody(creds, n);
  const poUrl = process.env.PUSHOVER_API_BASE || "https://api.pushover.net/1/messages.json";
  const t0 = performance.now();
  let child;
  try {
    child = spawn("sh", [DELIVER_SCRIPT], {
      detached: true,
      stdio: "ignore",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? os.homedir(),
        LANG: process.env.LANG ?? "C.UTF-8",
        PO_BODY: body,
        PO_URL: poUrl,
        PO_LOG: DELIVERIES_LOG,
        PO_KIND: kind,
        PO_SPAWN_MS: String(Math.max(0, Math.round(performance.now() - t0))),
      },
    });
  } catch {
    trace({ kind, action: "skip", reason: "spawn-error", fingerprint: parts.fingerprint });
    return;
  }
  const spawnMs = performance.now() - t0;
  try {
    child.on("error", () => {});
  } catch {
    // listener attachment must never throw
  }
  try {
    child.unref();
  } catch {
    // detach is best-effort
  }
  trace({
    kind,
    action: parts.traceAction ?? "sent",
    fingerprint: parts.fingerprint,
    spawnMs: Math.round(spawnMs),
  });
}

/** Fire-and-forget delivery; self-guarded so nothing escapes into omp's dispatch. */
function dispatch(kind: "done" | "blocked", parts: DispatchParts, ctx: CtxLike): void {
  try {
    runDispatch(kind, parts, ctx).catch(() => {});
  } catch {
    // fire-and-forget must never throw
  }
}

export default function pushoverNotify(pi: ExtensionAPI): void {
  try {
    pi.setLabel("Pushover Notify");
  } catch {
    // cosmetic
  }
  try {
    pi.logger?.info?.("pushover-notify: loaded");
  } catch {
    // cosmetic
  }

  try {
    pi.on("tool_call", (event) => {
      try {
        const id = event?.toolCallId;
        if (typeof id === "string" && id.length > 0) {
          rememberPreview(id, toolPreview(event.input));
        }
      } catch {
        // a tool_call error would block the tool call — never throw
      }
      return undefined;
    });
  } catch {
    // registration failure must not kill load
  }

  try {
    pi.on("tool_approval_requested", (event, ctx) => {
      try {
        const callId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
        const preview = callId ? previewMap.get(callId) : undefined;
        const top = isTopLevelSession(ctx);
        let ownId: string | undefined;
        try {
          const v = ctx?.sessionManager?.getSessionId?.();
          ownId = typeof v === "string" && v.length > 0 ? v : undefined;
        } catch {
          ownId = undefined;
        }
        const evSessionId = typeof event?.sessionId === "string" ? event.sessionId : undefined;
        const crossSession = !!evSessionId && !!ownId && evSessionId !== ownId;
        const toolName = typeof event?.toolName === "string" ? event.toolName : "";
        const reason = typeof event?.reason === "string" ? event.reason : "";
        const now = Date.now();
        const stats = turnStats(lastMessages, now);
        const isQuota = isQuotaSession(ctx, stats.provider);
        const draft = buildNotification({
          kind: "blocked",
          project: path.basename(resolveCwd(ctx)),
          contextLine: "",
          toolName,
          reason: reason || undefined,
          preview: preview ?? undefined,
          elapsedMs: stats.elapsedMs,
          tokens: stats.tokens,
          costUsd: stats.costUsd,
          isQuota,
        });
        const fp = fingerprint(`${draft.title}\n${draft.message}`);
        const last = sentBlocked.length > 0 ? sentBlocked[sentBlocked.length - 1] : undefined;
        const decision = decideBlocked({
          isTopLevel: top.ok,
          crossSession,
          fingerprint: fp,
          lastBlocked: last ? { fingerprint: last.fingerprint, atMs: last.at } : null,
          nowMs: now,
        });
        if (decision.action === "send") {
          sentBlocked.push({ fingerprint: fp, at: now });
          while (sentBlocked.length > SENT_BLOCKED_CAP) sentBlocked.shift();
          dispatch(
            "blocked",
            {
              fingerprint: fp,
              toolName,
              reason: reason || undefined,
              preview,
              elapsedMs: stats.elapsedMs,
              tokens: stats.tokens,
              costUsd: stats.costUsd,
              isQuota,
            },
          );
        } else {
          const reasonCode =
            decision.reason === "subagent-or-nested" && top.reason
              ? `subagent-or-nested:${top.reason}`
              : decision.reason;
          trace({ kind: "blocked", action: "skip", reason: reasonCode, fingerprint: fp });
        }
        if (callId) previewMap.delete(callId);
      } catch {
        // approval handling must never throw
      }
    });
  } catch {
    // registration failure must not kill load
  }
  try {
    pi.on("tool_execution_start", (event, ctx) => {
      try {
        if (event?.toolName !== "ask") {
          return;
        }
        const top = isTopLevelSession(ctx);
        if (!top.ok) {
          trace({
            kind: "blocked",
            action: "skip",
            reason: `subagent-or-nested:${top.reason ?? "unknown"}`,
          });
          return;
        }
        const callId = typeof event?.toolCallId === "string" ? event.toolCallId : "";
        const askArgs = {
          ...(event?.args !== null && typeof event?.args === "object" ? (event.args as Record<string, unknown>) : {}),
          intent: typeof event?.intent === "string" ? event.intent : undefined,
        };
        const parsed = parseAskInput(askArgs);
        const preview = (callId && previewMap.get(callId)) || toolPreview(askArgs);
        const now = Date.now();
        const stats = turnStats(lastMessages, now);
        const isQuota = isQuotaSession(ctx, stats.provider);
        const draft = buildNotification({
          kind: "blocked",
          project: path.basename(resolveCwd(ctx)),
          contextLine: "",
          toolName: "ask",
          topic: parsed.topic,
          question: parsed.question,
          options: parsed.options,
          preview,
          elapsedMs: stats.elapsedMs,
          tokens: stats.tokens,
          costUsd: stats.costUsd,
          isQuota,
        });
        const fp = fingerprint(`${draft.title}\n${draft.message}`);
        const last = sentBlocked.length > 0 ? sentBlocked[sentBlocked.length - 1] : undefined;
        const decision = decideBlocked({
          isTopLevel: top.ok,
          crossSession: false,
          fingerprint: fp,
          lastBlocked: last ? { fingerprint: last.fingerprint, atMs: last.at } : null,
          nowMs: now,
        });
        if (decision.action === "send") {
          sentBlocked.push({ fingerprint: fp, at: now });
          while (sentBlocked.length > SENT_BLOCKED_CAP) sentBlocked.shift();
          dispatch(
            "blocked",
            {
              fingerprint: fp,
              toolName: "ask",
              topic: parsed.topic,
              question: parsed.question,
              options: parsed.options,
              preview,
              elapsedMs: stats.elapsedMs,
              tokens: stats.tokens,
              costUsd: stats.costUsd,
              isQuota,
            },
            ctx,
          );
        } else {
          trace({ kind: "blocked", action: "skip", reason: decision.reason, fingerprint: fp });
        }
        if (callId) previewMap.delete(callId);
        return;
      } catch {
        // ask tool_execution_start must never throw
      }
    });
  } catch {
    // registration failure must not kill load
  }

  try {
    pi.on("agent_end", (event, ctx) => {
      try {
        const messages: unknown = event?.messages;
        if (event?.willContinue === true) {
          trace({ kind: "done", action: "skip", reason: "continuation" });
          return;
        }
        const top = isTopLevelSession(ctx);
        let busyJobs = 0;
        try {
          const snapshot = ctx?.getAsyncJobSnapshot?.() as
            | { running?: unknown; delivery?: unknown }
            | null
            | undefined;
          if (snapshot && typeof snapshot === "object") {
            if (Array.isArray(snapshot.running)) busyJobs += snapshot.running.length;
            busyJobs += countUndelivered(snapshot.delivery);
          }
        } catch {
          busyJobs += 1; // snapshot unavailable — hold rather than spam
        }
        const msgs: unknown[] = Array.isArray(messages) ? messages : [];
        const lastText = lastAssistantText(messages);
        const now = Date.now();
        const stats = turnStats(msgs, now);
        const err = lastErrorMessage(msgs);
        const isQuota = isQuotaSession(ctx, stats.provider);
        const turn: HeldTurn = {
          lastText,
          errorMessage: err,
          elapsedMs: stats.elapsedMs,
          tokens: stats.tokens,
          costUsd: stats.costUsd,
          isQuota,
        };
        const draft = buildNotification({
          kind: "done",
          project: path.basename(resolveCwd(ctx)),
          contextLine: "",
          ...turn,
        });
        const fp = fingerprint(`${draft.title}\n${draft.message}`);
        const decision = decideDone({
          isTopLevel: top.ok,
          willContinue: false,
          busyJobs,
          pendingHold,
          fingerprint: fp,
          lastSent: lastSentDone ? { fingerprint: lastSentDone.fingerprint, atMs: lastSentDone.at } : null,
          nowMs: now,
        });
        if (decision.action === "send") {
          lastSentDone = { fingerprint: fp, at: now };
          pendingHold = false;
          pendingDone = undefined;
          lastMessages = msgs;
          dispatch("done", { fingerprint: fp, ...turn }, ctx);
        } else if (decision.action === "hold") {
          pendingHold = true;
          pendingDone = turn;
          lastMessages = msgs;
          trace({ kind: "done", action: "hold", reason: decision.reason ?? "busy", fingerprint: fp });
        } else {
          const reasonCode =
            decision.reason === "subagent-or-nested" && top.reason
              ? `subagent-or-nested:${top.reason}`
              : decision.reason;
          trace({ kind: "done", action: "skip", reason: reasonCode, fingerprint: fp });
        }
      } catch {
        // agent_end handling must never throw
      }
    });
  } catch {
    // registration failure must not kill load
  }

  try {
    pi.on("session_shutdown", (_event, ctx) => {
      try {
        if (!pendingHold) return;
        pendingHold = false;
        const held: HeldTurn = pendingDone ?? { lastText: "" };
        pendingDone = undefined;
        const stats = turnStats(lastMessages, Date.now());
        const err = lastErrorMessage(lastMessages);
        const turn: HeldTurn = {
          lastText: held.lastText,
          errorMessage: held.errorMessage ?? err,
          elapsedMs: held.elapsedMs ?? stats.elapsedMs,
          tokens: held.tokens ?? stats.tokens,
          costUsd: held.costUsd ?? stats.costUsd,
          isQuota: held.isQuota ?? isQuotaSession(ctx, stats.provider),
        };
        const draft = buildNotification({
          kind: "done",
          project: path.basename(resolveCwd(ctx)),
          contextLine: "",
          ...turn,
        });
        dispatch(
          "done",
          {
            fingerprint: fingerprint(`${draft.title}\n${draft.message}`),
            traceAction: "flush-shutdown",
            ...turn,
          },
          ctx,
        );
      } catch {
        // best-effort flush
      }
    });
  } catch {
    // registration failure must not kill load
  }
}
