// pushover-notify/lib.ts — pure helpers for the Pushover notification extension.
// ZERO imports, ZERO I/O. Every function is total: never throws on bad input.

export const MESSAGE_CAP = 1024;
export const TITLE_CAP = 250;
export const PREVIEW_CAP = 200;
export const LAST_TEXT_CAP = 900;
export const DONE_DEDUPE_WINDOW_MS = 15_000;
export const BLOCKED_MIN_INTERVAL_MS = 20_000;
export const BLOCKED_DEDUPE_WINDOW_MS = 120_000;

export type Credentials = {
  user: string;
  token: string;
  source: "env" | "envFile" | "json";
};

export type Notification = {
  kind: "done" | "blocked";
  title: string;
  message: string;
  priority: number;
  sound?: string;
};

export type NotificationInput = {
  kind: "done" | "blocked";
  project: string;
  contextLine: string;
  lastText?: string;
  errorMessage?: string;
  toolName?: string;
  reason?: string;
  preview?: string;
  topic?: string;
  question?: string;
  options?: unknown[];
  elapsedMs?: number;
  tokens?: number;
  costUsd?: number;
  isQuota?: boolean;
};

export type Decision = { action: "send" | "hold" | "skip"; reason?: string };

const SECRET_MASK_RE = /(\S*(?:TOKEN|KEY|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL)\S*)=\S+/gi;

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function trimmed(value: unknown): string {
  return asText(value).trim();
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseEnvFileContent(text: unknown): { user: string; token: string } | null {
  if (typeof text !== "string" || text.length === 0) return null;
  let user = "";
  let token = "";
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key !== "PUSHOVER_USER" && key !== "PUSHOVER_TOKEN") continue;
    const value = stripQuotes(line.slice(eq + 1).trim());
    if (key === "PUSHOVER_USER") user = value;
    else token = value;
  }
  if (trimmed(user).length > 0 && trimmed(token).length > 0) {
    return { user: trimmed(user), token: trimmed(token) };
  }
  return null;
}

function parseJsonContent(text: unknown): { user: string; token: string } | null {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    const parsed = JSON.parse(text) as { pushover?: { userKey?: unknown; token?: unknown } } | null;
    const user = trimmed(parsed?.pushover?.userKey);
    const token = trimmed(parsed?.pushover?.token);
    if (user.length > 0 && token.length > 0) return { user, token };
  } catch {
    // malformed JSON simply fails this source
  }
  return null;
}

/** Pair-level credential chain: env -> env file -> JSON fallback. */
export function resolveCredentials(input: {
  env: Record<string, string | undefined>;
  envFileContent?: string | null;
  jsonContent?: string | null;
}): Credentials | null {
  try {
    const envUser = trimmed(input?.env?.PUSHOVER_USER);
    const envToken = trimmed(input?.env?.PUSHOVER_TOKEN);
    if (envUser.length > 0 && envToken.length > 0) {
      return { user: envUser, token: envToken, source: "env" };
    }
    const fromFile = parseEnvFileContent(input?.envFileContent ?? null);
    if (fromFile) return { user: fromFile.user, token: fromFile.token, source: "envFile" };
    const fromJson = parseJsonContent(input?.jsonContent ?? null);
    if (fromJson) return { user: fromJson.user, token: fromJson.token, source: "json" };
    return null;
  } catch {
    return null;
  }
}

function utf8Bytes(cp: number): number[] {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
}

/** application/x-www-form-urlencoded: keep [A-Za-z0-9-_.~], uppercase-hex the rest. */
export function encodeForm(pairs: ReadonlyArray<readonly [string, string | number]>): string {
  const parts: string[] = [];
  try {
    for (const pair of pairs ?? []) {
      if (!pair || pair.length < 2 || pair[0] == null || pair[1] == null) continue;
      parts.push(`${percentEncode(String(pair[0]))}=${percentEncode(String(pair[1]))}`);
    }
  } catch {
    // malformed input yields what was encoded so far
  }
  return parts.join("&");
}

function percentEncode(value: string): string {
  let out = "";
  for (const ch of value) {
    let cp = ch.codePointAt(0) ?? 0xfffd;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // lone surrogate -> U+FFFD
    // RFC 3986 unreserved set: A-Z a-z 0-9 - . _ ~
    const unreserved =
      (cp >= 0x30 && cp <= 0x39) ||
      (cp >= 0x41 && cp <= 0x5a) ||
      (cp >= 0x61 && cp <= 0x7a) ||
      cp === 0x2d ||
      cp === 0x2e ||
      cp === 0x5f ||
      cp === 0x7e;
    if (cp < 0x80 && unreserved) {
      out += ch;
      continue;
    }
    for (const byte of utf8Bytes(cp)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

function baseName(p: unknown): string {
  const s = asText(p);
  if (s.length === 0) return "";
  let end = s.length;
  while (end > 1 && (s[end - 1] === "/" || s[end - 1] === "\\")) end--;
  const slice = s.slice(0, end);
  if (slice === "/" || slice === "\\") return slice;
  const i = Math.max(slice.lastIndexOf("/"), slice.lastIndexOf("\\"));
  return i >= 0 ? slice.slice(i + 1) : slice;
}

export function formatContext(input: {
  isHerdr: boolean;
  workspaceId?: string | null;
  paneId?: string | null;
  cwd: string;
  branch?: string | null;
}): string {
  if (input?.isHerdr === true) {
    return `Herdr · ws ${input.workspaceId ?? "?"} · pane ${input.paneId ?? "?"}`;
  }
  const project = baseName(input?.cwd);
  const branch = input?.branch ?? null;
  return `Standalone · ${project}${branch ? ` · ${branch}` : ""}`;
}

export function parseGitBranch(stdout: string, exitCode: number): string | null {
  if (exitCode !== 0) return null;
  const branch = trimmed(stdout);
  if (branch.length === 0 || branch === "HEAD") return null;
  return branch;
}

export function formatDetachedHead(stdout: string): string {
  const sha = trimmed(stdout);
  return sha.length > 0 ? `detached@${sha}` : "detached";
}

/** Keep the head, cut the tail: truncated text is `max` long and ends in "..." when max > 3. */
export function truncateEnd(text: string, max: number): string {
  const s = asText(text);
  const m = typeof max === "number" && Number.isFinite(max) ? Math.floor(max) : 0;
  if (s.length <= m) return s;
  if (m > 3) return `${s.slice(0, m - 3)}...`;
  return s.slice(0, m);
}

function cleanIntent(intent: string): string {
  let s = intent.trim();
  s = s.replace(/^(asking|ask)\s+(?:the\s+)?(?:user\s+)?(?:for\s+|about\s+|to\s+)?/i, "");
  s = s.replace(/[.:;!]+$/, "").trim();
  if (s.length === 0) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatQuestionId(id: string): string {
  let s = id.trim().replace(/[_-]+/g, " ").trim();
  if (s.length === 0) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function cleanTopic(header: string): string {
  let s = header.trim().replace(/[.:;!]+$/, "").trim();
  if (s.length === 0) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function extractQuestionTopic(input: {
  intent?: string;
  header?: string;
  id?: string;
  question?: string;
}): string {
  if (typeof input.header === "string" && input.header.trim().length > 0) {
    const c = cleanTopic(input.header);
    if (c.length > 0) return c;
  }
  if (typeof input.intent === "string" && input.intent.trim().length > 0) {
    const c = cleanIntent(input.intent);
    if (c.length > 0) return c;
  }
  if (typeof input.id === "string" && input.id.trim().length > 0) {
    const c = formatQuestionId(input.id);
    if (c.length > 0) return c;
  }
  if (typeof input.question === "string" && input.question.trim().length > 0) {
    const firstSentence = input.question.trim().split(/[?.!\n]/)[0].trim();
    if (firstSentence.length > 0 && firstSentence.length <= 40) {
      return firstSentence.charAt(0).toUpperCase() + firstSentence.slice(1);
    }
  }
  return "Question";
}

export function formatQuestionOptions(options: unknown[]): string | undefined {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  const labels: string[] = [];
  for (const opt of options) {
    const raw =
      typeof opt === "string"
        ? opt
        : opt && typeof opt === "object" && typeof (opt as Record<string, unknown>).label === "string"
          ? String((opt as Record<string, unknown>).label)
          : "";
    const label = raw.trim();
    if (
      label.length > 0 &&
      !/^other\b/i.test(label) &&
      label !== "Chat about this" &&
      label !== "Next →"
    ) {
      labels.push(label);
    }
  }
  if (labels.length === 0) return undefined;
  return `› ${labels.join("  ·  ")}`;
}

export function parseAskInput(input: unknown): {
  topic: string;
  question: string;
  options: string[];
} {
  let topic = "";
  let question = "";
  const options: string[] = [];

  if (input !== null && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const intent = typeof obj.intent === "string" ? obj.intent : undefined;

    if (Array.isArray(obj.questions) && obj.questions.length > 0) {
      const first = obj.questions.find((item: unknown) => {
        if (item && typeof item === "object") {
          return typeof (item as Record<string, unknown>).question === "string";
        }
        return false;
      }) as Record<string, unknown> | undefined;

      if (first) {
        question = asText(first.question).trim();
        topic = extractQuestionTopic({
          intent,
          header: asText(first.header),
          id: asText(first.id),
          question,
        });
        if (Array.isArray(first.options)) {
          for (const opt of first.options) {
            const label =
              typeof opt === "string"
                ? opt
                : opt && typeof opt === "object" && typeof (opt as Record<string, unknown>).label === "string"
                  ? String((opt as Record<string, unknown>).label)
                  : "";
            if (label.trim().length > 0) options.push(label.trim());
          }
        }
      }
    } else if (typeof obj.question === "string" && obj.question.trim().length > 0) {
      question = obj.question.trim();
      topic = extractQuestionTopic({
        intent,
        header: asText(obj.header),
        id: asText(obj.id),
        question,
      });
      if (Array.isArray(obj.options)) {
        for (const opt of obj.options) {
          const label =
            typeof opt === "string"
              ? opt
              : opt && typeof opt === "object" && typeof (opt as Record<string, unknown>).label === "string"
                ? String((opt as Record<string, unknown>).label)
                : "";
          if (label.trim().length > 0) options.push(label.trim());
        }
      }
    }
  }

  if (topic.length === 0) topic = "Question";
  return { topic, question, options };
}
export function toolPreview(input: unknown): string {
  let raw: string | undefined;
  if (input !== null && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.questions) || typeof obj.question === "string") {
      const ask = parseAskInput(obj);
      if (ask.question.length > 0) {
        const optLine = formatQuestionOptions(ask.options);
        raw = optLine ? `${ask.question}\n${optLine}` : ask.question;
      }
    }
    if (raw === undefined) {
      for (const key of ["command", "path", "pattern", "task"]) {
        const value = obj[key];
        if (typeof value === "string" && value.length > 0) {
          raw = value;
          break;
        }
      }
    }
    if (raw === undefined) {
      let keyCount = 0;
      try {
        keyCount = Object.keys(obj).length;
      } catch {
        keyCount = 0;
      }
      if (keyCount > 0) {
        try {
          const json = JSON.stringify(input);
          if (typeof json === "string" && json.length > 0) raw = json;
        } catch {
          raw = undefined;
        }
      }
    }
  }
  if (raw === undefined || raw.length === 0) return "unknown input";
  const masked = raw.replace(SECRET_MASK_RE, "$1=[REDACTED]");
  return truncateEnd(masked, PREVIEW_CAP);
}

/** Stable 8-lowercase-hex-char FNV-1a (32-bit) over UTF-16 code units. */
export function fingerprint(text: string): string {
  const s = asText(text);
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, typeof ms === "number" && Number.isFinite(ms) ? Math.floor(ms / 1000) : 0);
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

/** toFixed(1) with the trailing zero and then the trailing dot stripped. */
function trimDecimal(n: number): string {
  let s = typeof n === "number" && Number.isFinite(n) ? n.toFixed(1) : "0.0";
  if (s.endsWith("0")) s = s.slice(0, -1);
  if (s.endsWith(".")) s = s.slice(0, -1);
  return s;
}

export function formatTokens(n: number): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return `${trimDecimal(v / 1000)}k`;
  return `${trimDecimal(v / 1e6)}M`;
}

/** Cents below a dollar (`4¢`, `0.02¢`), dollars at a dollar and up (`$12.50`); dollars is the fallback.
 * Prepends `ⓠ` when spending subscription/quota instead of real money (`ⓠ0.61¢`, `ⓠ$1.25`).
 */
export function formatCost(n: number, isQuota?: boolean): string {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;
  const prefix = isQuota === true ? "ⓠ" : "";
  if (v >= 1) return `${prefix}$${v.toFixed(2)}`;
  const cents = v * 100;
  if (cents === 0) return `${prefix}0¢`;
  if (cents >= 1) {
    const shown = trimDecimal(cents);
    return Number(shown) >= 100 ? `${prefix}$${v.toFixed(2)}` : `${prefix}${shown}¢`;
  }
  let s = cents >= 0.01 ? cents.toFixed(2) : cents.toFixed(3);
  while (s.endsWith("0")) s = s.slice(0, -1);
  if (s.endsWith(".")) s = s.slice(0, -1);
  return `${prefix}${s}¢`;
}

const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

function sumUsageFields(obj: Record<string, unknown>): { sum: number; any: boolean } {
  let sum = 0;
  let any = false;
  for (const key of USAGE_KEYS) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      sum += v;
      any = true;
    }
  }
  return { sum, any };
}

export function turnStats(
  messages: unknown[],
  nowMs: number,
): { elapsedMs: number; tokens?: number; costUsd?: number; provider?: string } {
  const out: { elapsedMs: number; tokens?: number; costUsd?: number; provider?: string } = { elapsedMs: 0 };
  try {
    if (!Array.isArray(messages)) return out;
    const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : 0;
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: unknown; timestamp?: unknown } | null;
      if (m && m.role === "user" && typeof m.timestamp === "number" && Number.isFinite(m.timestamp)) {
        out.elapsedMs = Math.max(0, now - m.timestamp);
        start = i + 1;
        break;
      }
    }
    let tokens = 0;
    let costUsd = 0;
    let sawUsage = false;
    let provider: string | undefined;
    for (let i = start; i < messages.length; i++) {
      const m = messages[i] as { role?: unknown; usage?: unknown; provider?: unknown } | null;
      if (!m || m.role !== "assistant") continue;
      if (typeof m.provider === "string" && m.provider.length > 0) {
        provider = m.provider;
      }
      const u = m.usage as Record<string, unknown> | null | undefined;
      if (!u || typeof u !== "object") continue;
      const totalTokens = u.totalTokens;
      if (typeof totalTokens === "number" && Number.isFinite(totalTokens)) {
        tokens += totalTokens;
        sawUsage = true;
      } else {
        const t = sumUsageFields(u);
        if (t.any) {
          tokens += t.sum;
          sawUsage = true;
        }
      }
      const cost = u.cost as Record<string, unknown> | null | undefined;
      if (cost && typeof cost === "object") {
        const total = cost.total;
        if (typeof total === "number" && Number.isFinite(total)) {
          costUsd += total;
          sawUsage = true;
        } else {
          const c = sumUsageFields(cost);
          if (c.any) {
            costUsd += c.sum;
            sawUsage = true;
          }
        }
      }
    }
    if (sawUsage) {
      out.tokens = tokens;
      out.costUsd = costUsd;
    }
    if (provider) {
      out.provider = provider;
    }
  } catch {
    // defensive: never throws
  }
  return out;
}

export function lastErrorMessage(messages: unknown[]): string | undefined {
  try {
    if (!Array.isArray(messages)) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | null;
      if (
        m &&
        m.role === "assistant" &&
        m.stopReason === "error" &&
        typeof m.errorMessage === "string" &&
        m.errorMessage.length > 0
      ) {
        return m.errorMessage;
      }
    }
  } catch {
    // defensive: never throws
  }
  return undefined;
}

export function buildNotification(input: NotificationInput): Notification {
  const kind: "done" | "blocked" = input?.kind === "blocked" ? "blocked" : "done";
  const project = asText(input?.project);
  const contextLine = asText(input?.contextLine);
  const errorMessage = asText(input?.errorMessage);
  const icon = kind === "blocked" ? "⚠️" : errorMessage ? "❌" : "✓";
  const elapsedMs = input?.elapsedMs;
  const segments = [project, `${icon}${elapsedMs != null ? formatElapsed(elapsedMs) : ""}`];
  const tokens = input?.tokens;
  if (tokens != null) segments.push(formatTokens(tokens));
  const costUsd = input?.costUsd;
  if (costUsd != null) segments.push(formatCost(costUsd, input?.isQuota));
  const title = truncateEnd(segments.join(" · "), TITLE_CAP);
  if (kind === "blocked") {
    const toolName = trimmed(input?.toolName) || "tool";
    if (toolName === "ask") {
      const question = trimmed(input?.question);
      const topic = trimmed(input?.topic);
      const titleText = question || topic || "Question";
      const title = truncateEnd(`${project} · 💬 ${titleText}`, TITLE_CAP);
      const bodyParts: string[] = [];
      const optLine = formatQuestionOptions((input?.options as unknown[]) ?? []);
      if (optLine) {
        bodyParts.push(optLine);
      } else if (input?.preview && input.preview !== question) {
        bodyParts.push(asText(input.preview));
      }
      if (contextLine) {
        bodyParts.push(contextLine);
      }
      const message = bodyParts.join("\n\n") || "Waiting for your answer";
      return {
        kind,
        title,
        message: truncateEnd(message, MESSAGE_CAP),
        priority: 1,
        sound: "siren",
      };
    }
    const reason = asText(input?.reason);
    const preview = asText(input?.preview);
    const elapsedMs = input?.elapsedMs;
    const segments = [project, `⚠️${elapsedMs != null ? formatElapsed(elapsedMs) : ""}`];
    if (input?.tokens != null) segments.push(formatTokens(input.tokens));
    if (input?.costUsd != null) segments.push(formatCost(input.costUsd, input.isQuota));
    const title = truncateEnd(segments.join(" · "), TITLE_CAP);
    let message = `Needs approval: ${toolName}`;
    if (reason) message += `\n${reason}`;
    if (preview) message += `\n${preview}`;
    message += `\n\n${contextLine}`;
    return { kind, title, message: truncateEnd(message, MESSAGE_CAP), priority: 1, sound: "siren" };
  }
  const text = truncateEnd(errorMessage || asText(input?.lastText) || "Task completed", LAST_TEXT_CAP);
  const message = truncateEnd(`${text}\n\n${contextLine}`, MESSAGE_CAP);
  return { kind, title, message, priority: 0 };
}

export function buildFormBody(
  creds: Credentials,
  n: { kind?: "done" | "blocked"; title: string; message: string; priority: number; sound?: string },
): string {
  const pairs: Array<readonly [string, string | number]> = [
    ["token", asText(creds?.token)],
    ["user", asText(creds?.user)],
    ["title", asText(n?.title)],
    ["message", asText(n?.message)],
    ["priority", String(n?.priority ?? 0)],
  ];
  const sound = asText(n?.sound);
  if (sound) pairs.push(["sound", sound]);
  return encodeForm(pairs);
}

export function decideDone(i: {
  isTopLevel: boolean;
  willContinue?: boolean;
  busyJobs?: number;
  pendingHold?: boolean;
  fingerprint: string;
  lastSent?: { fingerprint: string; atMs: number } | null;
  nowMs: number;
}): Decision {
  if (i?.willContinue === true) return { action: "skip", reason: "continuation" };
  if (i?.isTopLevel !== true) return { action: "skip", reason: "subagent-or-nested" };
  if (typeof i?.busyJobs === "number" && i.busyJobs > 0) return { action: "hold", reason: "busy" };
  const last = i?.lastSent ?? undefined;
  if (
    last &&
    typeof i?.nowMs === "number" &&
    last.fingerprint === i.fingerprint &&
    i.nowMs - last.atMs < DONE_DEDUPE_WINDOW_MS
  ) {
    return { action: "skip", reason: "dedupe" };
  }
  return { action: "send" };
}

export function decideBlocked(i: {
  isTopLevel: boolean;
  crossSession?: boolean;
  fingerprint: string;
  lastBlocked?: { fingerprint: string; atMs: number } | null;
  nowMs: number;
}): Decision {
  if (i?.isTopLevel !== true) return { action: "skip", reason: "subagent-or-nested" };
  if (i?.crossSession === true) return { action: "skip", reason: "cross-session" };
  const last = i?.lastBlocked ?? undefined;
  const now = typeof i?.nowMs === "number" ? i.nowMs : NaN;
  const age = last && typeof last.atMs === "number" ? now - last.atMs : NaN;
  if (last && last.fingerprint === i.fingerprint && age < BLOCKED_DEDUPE_WINDOW_MS) {
    return { action: "skip", reason: "dedupe" };
  }
  if (Number.isFinite(age) && age < BLOCKED_MIN_INTERVAL_MS) {
    return { action: "skip", reason: "debounce" };
  }
  return { action: "send" };
}
