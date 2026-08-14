import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_LINE_CHARS = 64 * 1024;
let fileLoggingFailed = false;
let resolvedLogPath: string | null | undefined;

/** True for unpackaged dev runs; false for packaged release builds. */
export function isDevLoggingEnabled(): boolean {
  return !app.isPackaged;
}

export function getDevLogPath(): string | null {
  if (!isDevLoggingEnabled()) {
    return null;
  }
  if (resolvedLogPath === undefined) {
    resolvedLogPath = path.join(app.getPath("userData"), "logs", "dartsnut-agent-dev.log");
  }
  return resolvedLogPath;
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|api[_-]?key|access[_-]?token)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function safeLogValue(value: unknown, key = "", seen = new WeakSet<object>(), depth = 0): unknown {
  if (/token|authorization|api.?key|password|secret|credential/i.test(key)) {
    return "[REDACTED]";
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (depth >= 6) {
    return "[MAX_DEPTH]";
  }
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);
  if (value instanceof Error) {
    const error = value as Error & { code?: unknown; cause?: unknown };
    return {
      name: error.name,
      message: redactString(error.message),
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(error.cause ? { cause: safeLogValue(error.cause, "cause", seen, depth + 1) } : {})
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => safeLogValue(item, "", seen, depth + 1));
  }
  const record: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    record[entryKey] = safeLogValue(entryValue, entryKey, seen, depth + 1);
  }
  return record;
}

function rotateLogIfNeeded(logPath: string): void {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size < MAX_LOG_BYTES) {
      return;
    }
    const previousPath = `${logPath}.1`;
    if (fs.existsSync(previousPath)) {
      fs.unlinkSync(previousPath);
    }
    fs.renameSync(logPath, previousPath);
  } catch {
    // Best-effort dev diagnostics must never break app startup or runtime.
  }
}

export function appendDevFileLog(level: string, ...args: unknown[]): void {
  if (!isDevLoggingEnabled()) {
    return;
  }
  if (fileLoggingFailed) {
    return;
  }
  const logPath = getDevLogPath();
  if (!logPath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateLogIfNeeded(logPath);
    const entry = {
      at: new Date().toISOString(),
      level,
      args: args.map((arg) => safeLogValue(arg))
    };
    const serialized = JSON.stringify(entry);
    const line = serialized.length > MAX_LOG_LINE_CHARS
      ? `${JSON.stringify({
        at: entry.at,
        level,
        truncated: true,
        originalChars: serialized.length,
        preview: serialized.slice(0, MAX_LOG_LINE_CHARS / 2)
      })}\n`
      : `${serialized}\n`;
    fs.appendFileSync(logPath, line, "utf-8");
  } catch (error) {
    fileLoggingFailed = true;
    console.warn("[dev-log] file logging disabled", error instanceof Error ? error.message : String(error));
  }
}

function write(level: "log" | "info" | "warn" | "error" | "debug", args: unknown[]): void {
  if (!isDevLoggingEnabled()) {
    return;
  }
  console[level](...args);
}

export const devLog = {
  log(...args: unknown[]): void {
    write("log", args);
  },
  info(...args: unknown[]): void {
    write("info", args);
  },
  warn(...args: unknown[]): void {
    write("warn", args);
  },
  error(...args: unknown[]): void {
    write("error", args);
  },
  debug(...args: unknown[]): void {
    write("debug", args);
  }
};
