import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateDeployWorkspaceConf,
  type AgentEvent,
  type LlmProviderId,
  type WidgetSize
} from "@dartsnut/shared-ipc";
import {
  createIntakeHostHandlers,
  nextAfterProjectType
} from "../../src/creationIntakeHost";
import { AgentSessionPersistence } from "../../src/agentSessionPersistence";
import { ProviderClient } from "../../src/providerClient";
import type { ProviderConfig } from "../../src/providerConfig";
import { loadProviderConfig, validateProviderConfig } from "../../src/providerConfig";
import {
  allowedDeferredSkillIdsForMode,
  resolveSkillRouterPrompt
} from "../../src/skillBundle";
import { SessionEngine } from "../../src/sessionEngine";
import { AGENT_TOOL_SCHEMAS } from "../../src/toolSchemas";
import { WorkspacePolicy } from "../../src/workspacePolicy";

export const INITIAL_BREATHING_WIDGET_PROMPT = "我想要一个可爱的呼吸小组件";
export const BREATHING_WIDGET_SIZE: WidgetSize = "128x128";
export const BUILTIN_E2E_PROVIDERS = ["xiaomi", "gpt", "gemini", "claude"] as const satisfies readonly LlmProviderId[];

const DEFAULT_E2E_TIMEOUT_MS = 600_000;
const SLOW_PROVIDER_E2E_TIMEOUT_MS = 1_200_000;

/** Per-provider Vitest timeout; override with `E2E_PROVIDER_TIMEOUT_MS`. */
export function e2eTimeoutMsForProvider(providerId: LlmProviderId): number {
  const fromEnv = process.env.E2E_PROVIDER_TIMEOUT_MS?.trim();
  if (fromEnv && Number.isFinite(Number(fromEnv))) {
    return Number(fromEnv);
  }
  return providerId === "claude" ? SLOW_PROVIDER_E2E_TIMEOUT_MS : DEFAULT_E2E_TIMEOUT_MS;
}

export interface BreathingWidgetE2eBaseline {
  hostIntakeActions: string[];
  askQuestions: string[];
  intakeToolNames: string[];
  creatorToolNames: string[];
  requiredEventTypes: string[];
  minReasoningChars: number;
  requireReasoningStream: boolean;
}

export interface BreathingWidgetFlowResult {
  providerId: LlmProviderId;
  hostIntakeActions: string[];
  askQuestions: string[];
  intakeToolNames: string[];
  creatorToolNames: string[];
  eventTypes: string[];
  reasoningChars: number;
  hadReasoningStream: boolean;
  streamedAssistantLen: number;
  intakeState: { projectType?: string; widgetSize?: string };
}

export interface CompareFlowToBaselineOptions {
  /** When true, assert reasoning stream from baseline (Xiaomi only). */
  compareReasoning?: boolean;
  /**
   * When true, creator tool names must follow the Xiaomi baseline subsequence (stricter).
   * Cross-provider runs use milestone checks only because models may skip replace_in_file.
   */
  compareCreatorToolOrderToBaseline?: boolean;
}

/** Canonical intake host steps after chip-simulated size selection. */
export const CANONICAL_HOST_INTAKE_ACTIONS = [
  "set_project_type",
  "set_widget_size",
  "read_workspace_conf"
] as const;

const REQUIRED_INTAKE_TOOL_PATTERN = [
  "dartsnut_project_intake",
  "dartsnut_ask_question",
  "dartsnut_project_intake"
] as const;

export function normalizeHostIntakeActions(actions: string[]): string[] {
  let out = collapseConsecutiveToolNames([...actions]);
  const seen = new Set<string>();
  out = out.filter((action) => {
    if (seen.has(action)) {
      return false;
    }
    seen.add(action);
    return true;
  });
  if (
    out.includes("set_project_type") &&
    out.includes("read_workspace_conf") &&
    !out.includes("set_widget_size")
  ) {
    const readIdx = out.indexOf("read_workspace_conf");
    out.splice(readIdx, 0, "set_widget_size");
  }
  return out;
}

function assertCreatorToolMilestones(creatorToolNames: string[]): string | null {
  if (!isSubsequenceInOrder(["get_dartsnut_skill", "write_file"], creatorToolNames)) {
    return `creatorToolNames missing ordered get_dartsnut_skill → write_file in ${JSON.stringify(creatorToolNames)}`;
  }
  if (
    creatorToolNames.includes("reload_emulator") &&
    !creatorToolNames.includes("get_emulator_logs")
  ) {
    return "creatorToolNames has reload_emulator without get_emulator_logs";
  }
  return null;
}

/** Collapse consecutive duplicate tool names (e.g. parallel skill loads). */
export function collapseConsecutiveToolNames(names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (out.length > 0 && out[out.length - 1] === name) {
      continue;
    }
    out.push(name);
  }
  return out;
}

function isSubsequenceInOrder(required: readonly string[], actual: string[]): boolean {
  let j = 0;
  for (let i = 0; i < actual.length && j < required.length; i++) {
    if (actual[i] === required[j]) {
      j += 1;
    }
  }
  return j === required.length;
}

export function ensureE2eRepoRoot(): string {
  const repoRoot = path.resolve(__dirname, "../../../..");
  process.env.DARTSNUT_REPO_ROOT = repoRoot;
  if (!process.env.AGENT_TOOL_LOOP_MAX?.trim()) {
    process.env.AGENT_TOOL_LOOP_MAX = "24";
  }
  return repoRoot;
}

function wrapProviderForE2eLogging(
  inner: ProviderClient,
  label: string
): ProviderClient {
  if (process.env.E2E_VERBOSE !== "1") {
    return inner;
  }
  let call = 0;
  const wrapped = {
    complete: async (
      messages: Parameters<ProviderClient["complete"]>[0],
      options?: Parameters<ProviderClient["complete"]>[1]
    ) => {
      call += 1;
      const started = Date.now();
      console.log(`[e2e ${label}] completion #${call} (${messages.length} messages)`);
      const result = await inner.complete(messages, options);
      console.log(
        `[e2e ${label}] completion #${call} done in ${Date.now() - started}ms — tools=${result.toolCalls.length} contentChars=${result.content.length} reasoningChars=${result.reasoningContent?.length ?? 0}`
      );
      return result;
    }
  };
  return wrapped as ProviderClient;
}

export function providerConfigForE2e(providerId: LlmProviderId): ProviderConfig {
  ensureE2eRepoRoot();
  return loadProviderConfig({ activeProvider: providerId });
}

export function canRunProviderE2e(providerId: LlmProviderId): boolean {
  const config = providerConfigForE2e(providerId);
  return validateProviderConfig(config, providerId).ok;
}

function resolveSkillsDir(): string {
  return path.resolve(__dirname, "../../skills");
}

function parseTransactions(workspaceRoot: string): Array<Record<string, unknown>> {
  const file = path.join(workspaceRoot, ".dartsnut", "agent-session", "transactions.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function toolCallsFromTransactions(transactions: Array<Record<string, unknown>>): string[] {
  return transactions
    .filter((row) => row.type === "tool.call")
    .map((row) => String(row.name ?? ""));
}

function uniqueEventTypes(events: AgentEvent[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const event of events) {
    if (!seen.has(event.type)) {
      seen.add(event.type);
      ordered.push(event.type);
    }
  }
  return ordered;
}

function resolvePythonExecutable(): string {
  const fromEnv = process.env.DARTSNUT_PYTHON?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  for (const candidate of ["python3.12", "python3.11", "python3.10", "python3"]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf-8" });
    if (probe.status === 0) {
      return candidate;
    }
  }
  return "python3";
}

function assertArtifacts(workspaceRoot: string): void {
  const confPath = path.join(workspaceRoot, "conf.json");
  const mainPath = path.join(workspaceRoot, "main.py");
  if (!fs.existsSync(confPath)) {
    throw new Error("Expected conf.json to exist after creator phase");
  }
  if (!fs.existsSync(mainPath)) {
    throw new Error("Expected main.py to exist after creator phase");
  }

  const raw = JSON.parse(fs.readFileSync(confPath, "utf-8")) as unknown;
  const deploy = validateDeployWorkspaceConf(raw);
  if (!deploy.ok) {
    throw new Error(`conf.json failed deploy validation: ${deploy.reason}`);
  }
  const conf = raw as Record<string, unknown>;
  if (conf.type !== "widget") {
    throw new Error(`Expected conf.json type widget, got ${String(conf.type)}`);
  }
  if (!Array.isArray(conf.size) || conf.size[0] !== 128 || conf.size[1] !== 128) {
    throw new Error(`Expected conf.json size [128, 128], got ${JSON.stringify(conf.size)}`);
  }

  const mainPy = fs.readFileSync(mainPath, "utf-8");
  const looksImplemented =
    /breath|alpha|sin|pulse|scale|opacity/i.test(mainPy) && mainPy.length > 300;
  if (!looksImplemented) {
    throw new Error("main.py does not look like an implemented breathing widget");
  }

  const python = resolvePythonExecutable();
  const compileResult = spawnSync(python, ["-m", "py_compile", mainPath], {
    cwd: workspaceRoot,
    encoding: "utf-8"
  });
  if (compileResult.status !== 0) {
    throw new Error(
      `main.py failed py_compile: ${compileResult.stderr || compileResult.stdout || "unknown error"}`
    );
  }
}

function assertFlowHealth(
  events: AgentEvent[],
  transactions: Array<Record<string, unknown>>,
  streamedAssistant: string,
  response: string,
  streamedReasoning: string
): { reasoningChars: number; hadReasoningStream: boolean } {
  if (transactions.some((row) => row.type === "creator.incomplete_turn")) {
    throw new Error("Creator incomplete_turn recorded in transactions");
  }

  const hadFileMutationTools = transactions.some(
    (row) =>
      row.type === "tool.call" &&
      (row.name === "write_file" ||
        row.name === "replace_in_file" ||
        row.name === "copy_asset_file")
  );
  const completionResponses = transactions.filter((row) => row.type === "completion.response");
  const terminal = completionResponses[completionResponses.length - 1];
  if (terminal && terminal.toolCallCount === 0 && !hadFileMutationTools) {
    const reasoningChars =
      typeof terminal.reasoningChars === "number" ? terminal.reasoningChars : 0;
    const contentChars =
      typeof terminal.contentLength === "number" ? terminal.contentLength : 0;
    const proseChars = reasoningChars + contentChars;
    if (proseChars > 15_000) {
      throw new Error(
        `Terminal step was prose-only (${proseChars} chars); expected file tools`
      );
    }
  }

  if (!events.some((event) => event.type === "final")) {
    throw new Error("Expected a final agent event");
  }
  if (!events.some((event) => event.type === "stream")) {
    throw new Error("Expected stream events for assistant output");
  }
  if (!events.some((event) => event.type === "status")) {
    throw new Error("Expected status events for tool runs");
  }

  const combinedAssistant = `${streamedAssistant}\n${response}`;
  if (!/conf\.json|widget|呼吸|breath|done|ready|完成/i.test(combinedAssistant)) {
    throw new Error("Assistant output does not mention completion or widget artifacts");
  }

  if (streamedReasoning.length > 80_000) {
    throw new Error(`Reasoning stream too large (${streamedReasoning.length} chars)`);
  }

  return {
    reasoningChars: streamedReasoning.length,
    hadReasoningStream: events.some((event) => event.type === "reasoning_stream")
  };
}

export function flowResultToBaseline(result: BreathingWidgetFlowResult): BreathingWidgetE2eBaseline {
  return {
    hostIntakeActions: normalizeHostIntakeActions(result.hostIntakeActions),
    askQuestions: result.askQuestions,
    intakeToolNames: collapseConsecutiveToolNames(result.intakeToolNames),
    creatorToolNames: collapseConsecutiveToolNames(result.creatorToolNames),
    requiredEventTypes: result.eventTypes.filter((t) =>
      ["status", "stream", "final"].includes(t)
    ),
    minReasoningChars: result.reasoningChars,
    requireReasoningStream: result.hadReasoningStream
  };
}

export function compareFlowToBaseline(
  result: BreathingWidgetFlowResult,
  baseline: BreathingWidgetE2eBaseline,
  options?: CompareFlowToBaselineOptions
): string[] {
  const errors: string[] = [];
  const hostGot = normalizeHostIntakeActions(result.hostIntakeActions);
  const hostExpected = normalizeHostIntakeActions(baseline.hostIntakeActions);
  if (JSON.stringify(hostGot) !== JSON.stringify(hostExpected)) {
    errors.push(
      `hostIntakeActions mismatch: got ${JSON.stringify(hostGot)} expected ${JSON.stringify(hostExpected)}`
    );
  }
  if (JSON.stringify(result.askQuestions) !== JSON.stringify(baseline.askQuestions)) {
    errors.push(
      `askQuestions mismatch: got ${JSON.stringify(result.askQuestions)} expected ${JSON.stringify(baseline.askQuestions)}`
    );
  }

  if (!isSubsequenceInOrder(REQUIRED_INTAKE_TOOL_PATTERN, result.intakeToolNames)) {
    errors.push(
      `intakeToolNames missing required pattern ${JSON.stringify(REQUIRED_INTAKE_TOOL_PATTERN)} in ${JSON.stringify(result.intakeToolNames)}`
    );
  }
  const intakeBaseline = collapseConsecutiveToolNames(baseline.intakeToolNames);
  const intakeGot = collapseConsecutiveToolNames(result.intakeToolNames);
  if (
    intakeBaseline.length > 0 &&
    !isSubsequenceInOrder(intakeBaseline, intakeGot)
  ) {
    errors.push(
      `intakeToolNames not a superset of baseline order: got ${JSON.stringify(intakeGot)} expected baseline subsequence ${JSON.stringify(intakeBaseline)}`
    );
  }

  const creatorMilestoneError = assertCreatorToolMilestones(result.creatorToolNames);
  if (creatorMilestoneError) {
    errors.push(creatorMilestoneError);
  }
  if (options?.compareCreatorToolOrderToBaseline) {
    const creatorBaseline = collapseConsecutiveToolNames(baseline.creatorToolNames);
    const creatorGot = collapseConsecutiveToolNames(result.creatorToolNames);
    if (
      creatorBaseline.length > 0 &&
      !isSubsequenceInOrder(creatorBaseline, creatorGot)
    ) {
      errors.push(
        `creatorToolNames not a superset of baseline order: got ${JSON.stringify(creatorGot)} expected baseline subsequence ${JSON.stringify(creatorBaseline)}`
      );
    }
  }

  for (const eventType of baseline.requiredEventTypes) {
    if (!result.eventTypes.includes(eventType)) {
      errors.push(`missing event type: ${eventType}`);
    }
  }

  if (options?.compareReasoning && baseline.requireReasoningStream && !result.hadReasoningStream) {
    errors.push("expected reasoning_stream events");
  }

  return errors;
}

function isTransientProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /ECONNRESET|socket hang up|502|503|429|quota|rate limit|timeout/i.test(message) ||
    (error instanceof Error && error.cause != null && isTransientProviderError(error.cause))
  );
}

async function withE2eRetry<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 2;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isTransientProviderError(error)) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function runBreathingWidgetFlow(
  providerId: LlmProviderId,
  config: ProviderConfig
): Promise<BreathingWidgetFlowResult> {
  const log = (phase: string) => {
    if (process.env.E2E_VERBOSE === "1") {
      console.log(`[e2e ${providerId}] ${phase}`);
    }
  };
  log("start");
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `dartsnut-breathing-e2e-${providerId}-`));
  const skillsDir = resolveSkillsDir();
  const persistence = new AgentSessionPersistence(tempRoot);
  const events: AgentEvent[] = [];
  let streamedAssistant = "";
  let streamedReasoning = "";

  const hostIntakeActions: string[] = [];
  const askQuestions: string[] = [];

  const intakeHandlers = createIntakeHostHandlers({
    workspaceRoot: tempRoot,
    onHostIntakeAction: (action) => hostIntakeActions.push(action),
    onAskQuestionInvoked: (questionId) => askQuestions.push(questionId),
    onPromptEvent: (event) => events.push(event),
    resolveAskQuestion: async (questionId, state) => {
      if (questionId === "widget_display_size") {
        state.projectType = "widget";
        state.widgetSize = BREATHING_WIDGET_SIZE;
        if (!hostIntakeActions.includes("set_widget_size")) {
          hostIntakeActions.push("set_widget_size");
        }
        return JSON.stringify({
          ok: true,
          recorded: { widgetSize: BREATHING_WIDGET_SIZE },
          next: "Call **read_workspace_conf** — returns `conf.json` status for the active workspace."
        });
      }
      if (questionId === "project_type") {
        state.projectType = "widget";
        return JSON.stringify({
          ok: true,
          recorded: { projectType: "widget" },
          next: nextAfterProjectType("widget")
        });
      }
      return JSON.stringify({ ok: false, error: `Unknown question_id: ${questionId}` });
    }
  });

  const provider = wrapProviderForE2eLogging(new ProviderClient(config), providerId);

  const unifiedEngine = new SessionEngine({
    provider,
    workspacePolicy: new WorkspacePolicy(tempRoot),
    skillPrompt: resolveSkillRouterPrompt(skillsDir, null),
    completionTools: AGENT_TOOL_SCHEMAS,
    skillLibrary: {
      skillsDir,
      allowedIds: allowedDeferredSkillIdsForMode(null)
    },
    hostIntakeToolHandler: intakeHandlers.hostIntakeToolHandler,
    hostAskQuestionHandler: intakeHandlers.hostAskQuestionHandler,
    hostReloadEmulatorHandler: async () => "reload_emulator ok (e2e noop)",
    hostGetEmulatorLogsHandler: async () =>
      JSON.stringify({ ok: true, lines: [], emulator: { running: false, status: "Idle" } }),
    sessionPersistence: persistence,
    sessionTemplateMode: null
  });

  log("unified-session");
  const response = await withE2eRetry(() =>
    unifiedEngine.runPrompt(INITIAL_BREATHING_WIDGET_PROMPT, (event) => {
      events.push(event);
      if (event.type === "stream") {
        streamedAssistant += event.delta;
      }
      if (event.type === "reasoning_stream") {
        streamedReasoning += event.delta;
      }
    })
  );
  if (
    response.includes("Tool loop limit reached") ||
    response.includes("could not scaffold conf.json")
  ) {
    throw new Error(`Unified flow failed: ${response}`);
  }

  const intakeState = intakeHandlers.state;
  if (intakeState.projectType !== "widget" || intakeState.widgetSize !== BREATHING_WIDGET_SIZE) {
    throw new Error(
      `Intake state invalid: projectType=${String(intakeState.projectType)} widgetSize=${String(intakeState.widgetSize)}`
    );
  }

  const transactions = parseTransactions(tempRoot);
  const allToolNames = toolCallsFromTransactions(transactions);
  const intakeToolNames = allToolNames.filter(
    (name) => name === "dartsnut_project_intake" || name === "dartsnut_ask_question"
  );
  const creatorToolNames = allToolNames.filter(
    (name) => name !== "dartsnut_project_intake" && name !== "dartsnut_ask_question"
  );
  const completionRounds = transactions.filter((r) => r.type === "completion.response").length;
  log(`unified done (${allToolNames.length} tools, ${completionRounds} completion rounds)`);

  const health = assertFlowHealth(
    events,
    transactions,
    streamedAssistant,
    response,
    streamedReasoning
  );
  assertArtifacts(tempRoot);
  log("done");

  return {
    providerId,
    hostIntakeActions,
    askQuestions,
    intakeToolNames,
    creatorToolNames,
    eventTypes: uniqueEventTypes(events),
    reasoningChars: health.reasoningChars,
    hadReasoningStream: health.hadReasoningStream,
    streamedAssistantLen: streamedAssistant.length,
    intakeState: {
      projectType: intakeState.projectType,
      widgetSize: intakeState.widgetSize
    }
  };
}
