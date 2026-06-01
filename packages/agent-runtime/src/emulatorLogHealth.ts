export const EMULATOR_VERIFY_CLEAN_SUMMARY = "Widget runs cleanly in the emulator.";

export interface ParsedEmulatorLogsPayload {
  ok?: boolean;
  error?: string;
  lines?: unknown[];
  emulator?: {
    lastError?: string | null;
    status?: string;
    running?: boolean;
  };
}

const RUNTIME_ERROR_PATTERNS: RegExp[] = [
  /Traceback \(most recent call last\)/,
  /\bSyntaxError\b/,
  /\bIndentationError\b/,
  /\bModuleNotFoundError\b/,
  /\bImportError\b/,
  /\bNameError\b/,
  /\bAttributeError\b/,
  /\bTypeError\b/,
  /\bRuntimeError\b/,
  /\bFileNotFoundError\b/,
  /\bValueError\b/
];

export function lineTextFromEmulatorLogEntry(line: unknown): string {
  if (typeof line === "string") {
    return line;
  }
  if (!line || typeof line !== "object") {
    return "";
  }
  const record = line as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.message === "string") {
    return record.message;
  }
  return "";
}

export function parseEmulatorLogsToolResult(resultJson: string): ParsedEmulatorLogsPayload | null {
  try {
    const parsed: unknown = JSON.parse(resultJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as ParsedEmulatorLogsPayload;
  } catch {
    return null;
  }
}

export function emulatorLogTextHasRuntimeErrors(text: string): boolean {
  if (text.trim().length === 0) {
    return false;
  }
  return RUNTIME_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

export function emulatorLogsPayloadHasRuntimeErrors(payload: ParsedEmulatorLogsPayload): boolean {
  if (payload.ok === false) {
    return true;
  }
  if (typeof payload.error === "string" && payload.error.trim().length > 0) {
    return true;
  }
  const lastError = payload.emulator?.lastError;
  if (typeof lastError === "string" && lastError.trim().length > 0) {
    return true;
  }
  const combinedLines = (payload.lines ?? []).map(lineTextFromEmulatorLogEntry).join("\n");
  return emulatorLogTextHasRuntimeErrors(combinedLines);
}

export function isEmulatorLogsToolResultClean(resultJson: string): boolean {
  const payload = parseEmulatorLogsToolResult(resultJson);
  if (!payload) {
    return false;
  }
  return !emulatorLogsPayloadHasRuntimeErrors(payload);
}

export interface EmulatorToolOutcome {
  toolCall: { name: string };
  result: string;
}

export interface EmulatorVerifyBatchState {
  reloadPending: boolean;
}

export interface EmulatorVerifyBatchResult {
  reloadPending: boolean;
  cleanVerifyAfterReload: boolean;
}

/**
 * Track reload → get_emulator_logs verify cycles across tool batches.
 * Returns true when logs were fetched after a reload and contain no runtime errors.
 */
export function assessEmulatorVerifyBatch(
  outcomes: EmulatorToolOutcome[],
  state: EmulatorVerifyBatchState
): EmulatorVerifyBatchResult {
  let sawReload = false;
  let sawLogs = false;
  let hadFileMutation = false;
  let logsResult: string | null = null;

  for (const outcome of outcomes) {
    const name = outcome.toolCall.name;
    if (name === "write_file" || name === "replace_in_file" || name === "copy_asset_file") {
      hadFileMutation = true;
    }
    if (name === "reload_emulator") {
      sawReload = true;
    }
    if (name === "get_emulator_logs") {
      sawLogs = true;
      logsResult = outcome.result;
    }
  }

  let reloadPending = state.reloadPending;
  if (hadFileMutation && !sawReload) {
    reloadPending = false;
  }
  if (sawReload) {
    reloadPending = true;
  }

  const verifyAfterReload = sawLogs && (sawReload || (reloadPending && !hadFileMutation));
  const cleanVerifyAfterReload =
    verifyAfterReload && logsResult !== null && isEmulatorLogsToolResultClean(logsResult);

  if (sawLogs) {
    reloadPending = false;
  }

  return {
    reloadPending,
    cleanVerifyAfterReload
  };
}
