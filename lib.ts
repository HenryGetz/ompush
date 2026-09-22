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
  elapsedMs?: number | null;
  toolName?: string | null;
  reason?: string | null;
  preview?: string | null;
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

export function toolPreview(input: unknown): string {
  let raw: string | undefined;
  if (input !== null && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    for (const key of ["command", "path", "pattern", "task"]) {
      const value = obj[key];
      if (typeof value === "string" && value.length > 0) {
        raw = value;
        break;
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

function formatElapsedSuffix(elapsedMs: number): string {
  const s = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(s / 60);
  return ` (elapsed: ${minutes}m ${s % 60}s)`;
}

export function buildNotification(input: NotificationInput): Notification {
  const kind: "done" | "blocked" = input?.kind === "blocked" ? "blocked" : "done";
  const project = asText(input?.project);
  const contextLine = asText(input?.contextLine);
  if (kind === "blocked") {
    const title = truncateEnd(`[blocked] ${project}`, TITLE_CAP);
    const toolName = trimmed(input?.toolName) || "tool";
    const reason = asText(input?.reason);
    const preview = asText(input?.preview);
    let message = `Needs approval: ${toolName}`;
    if (reason) message += `\n${reason}`;
    if (preview) message += `\n${preview}`;
    message += `\n\n${contextLine}`;
    return { kind, title, message: truncateEnd(message, MESSAGE_CAP), priority: 1, sound: "siren" };
  }
  const title = truncateEnd(`[complete] ${project}`, TITLE_CAP);
  const lastText = asText(input?.lastText) || "Task completed";
  const elapsedMs = input?.elapsedMs;
  const suffix =
    typeof elapsedMs === "number" && Number.isFinite(elapsedMs) ? formatElapsedSuffix(elapsedMs) : "";
  const message = truncateEnd(`${truncateEnd(lastText, LAST_TEXT_CAP)}${suffix}\n\n${contextLine}`, MESSAGE_CAP);
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
