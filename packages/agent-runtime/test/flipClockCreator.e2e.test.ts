import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCreatorBuildPlanMessage } from "@dartsnut/shared-ipc";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import { AgentSessionPersistence } from "../src/agentSessionPersistence";
import { loadProviderConfig, validateProviderConfig } from "../src/providerConfig";
import { allowedDeferredSkillIdsForMode } from "../src/skillBundle";
import { SessionEngine } from "../src/sessionEngine";
import { buildAgentModelConfig } from "../src/agentProviderConfig";
import { WorkspacePolicy } from "../src/workspacePolicy";

const config = loadProviderConfig();
const canRunLive = validateProviderConfig(config).ok;

function buildFlipClockRoutedPrompt(workspacePath: string): string {
  const buildPlan = formatCreatorBuildPlanMessage({
    templateMode: "widget-creator",
    projectType: "widget",
    widgetSize: "128x128"
  });
  const context = {
    projectType: "widget",
    widgetSize: "128x128",
    workspacePath
  };
  return [
    buildPlan,
    "",
    "Creation context:",
    JSON.stringify(context, null, 2),
    "",
    "User request:",
    "create 128x128 flipping clock widget"
  ].join("\n");
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

describe.skipIf(!canRunLive)("flip-clock creator live e2e", () => {
  it(
    "scaffolds conf/main and uses read_file plus replace_in_file on main.py",
    async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-flip-clock-e2e-"));
      const skillsDir = path.resolve(__dirname, "../skills");
      const persistence = new AgentSessionPersistence(tempRoot);
      const events: AgentEvent[] = [];
      let streamedAssistant = "";
      let streamedReasoning = "";

      const engine = new SessionEngine({
        agentModelConfig: buildAgentModelConfig({
          model: config.model,
          baseUrl: config.baseUrl,
          apiKey: config.apiKey
        }),
        workspacePolicy: new WorkspacePolicy(tempRoot),
        skillLibrary: {
          skillsDir,
          allowedIds: allowedDeferredSkillIdsForMode("widget-creator")
        },
        hostReloadEmulatorHandler: async () => "reload_emulator ok (e2e noop)",
        hostGetEmulatorLogsHandler: async () =>
          JSON.stringify({ ok: true, lines: [], emulator: { running: false, status: "Idle" } }),
        hostCheckPythonHandler: async () => JSON.stringify({ ok: true, errors: [] }),
        sessionPersistence: persistence,
        sessionTemplateMode: "widget-creator",
        sessionSection: "widget-creator",
        runContextSeed: {
          projectType: "widget",
          widgetSize: "128x128",
          templateMode: "widget-creator",
          intakeState: { projectType: "widget", widgetSize: "128x128" }
        }
      });

      const prompt = buildFlipClockRoutedPrompt(tempRoot);
      const response = await engine.runPrompt(prompt, (event) => {
        events.push(event);
        if (event.type === "stream") {
          streamedAssistant += event.delta;
        }
        if (event.type === "reasoning_stream") {
          streamedReasoning += event.delta;
        }
      });

      const confPath = path.join(tempRoot, "conf.json");
      const mainPath = path.join(tempRoot, "main.py");
      expect(fs.existsSync(confPath)).toBe(true);
      expect(fs.existsSync(mainPath)).toBe(true);

      const mainPy = fs.readFileSync(mainPath, "utf-8");
      const looksImplemented =
        /draw\.text|imagedraw\s*\(|flip|digit|strftime|font/i.test(mainPy) && mainPy.length > 350;
      expect(looksImplemented).toBe(true);

      const combinedAssistant = `${streamedAssistant}\n${response}`;
      expect(combinedAssistant.toLowerCase()).toMatch(/conf\.json|widget|clock|flip|done|ready/);

      const transactions = parseTransactions(tempRoot);
      const toolNames = toolCallsFromTransactions(transactions);
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("replace_in_file");
      if (toolNames.includes("reload_emulator")) {
        expect(toolNames).toContain("get_emulator_logs");
      }
      expect(transactions.some((row) => row.type === "creator.stall_turn")).toBe(false);
      expect(transactions.some((row) => row.type === "creator.incomplete_turn")).toBe(false);

      const completionResponses = transactions.filter((row) => row.type === "completion.response");
      const terminalReasoningOnly = completionResponses[completionResponses.length - 1];
      if (
        terminalReasoningOnly &&
        terminalReasoningOnly.toolCallCount === 0 &&
        typeof terminalReasoningOnly.reasoningChars === "number" &&
        terminalReasoningOnly.reasoningChars > 15_000
      ) {
        throw new Error(
          `Terminal step was reasoning-only (${terminalReasoningOnly.reasoningChars} chars); expected file tools`
        );
      }

      expect(events.some((event) => event.type === "final")).toBe(true);
      expect(streamedReasoning.length).toBeLessThan(80_000);
    },
    600_000
  );
});
