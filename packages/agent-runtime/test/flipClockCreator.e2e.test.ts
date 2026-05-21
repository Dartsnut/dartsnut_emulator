import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCreatorBuildPlanMessage } from "@dartsnut/shared-ipc";
import type { AgentEvent } from "@dartsnut/shared-ipc";
import { AgentSessionPersistence } from "../src/agentSessionPersistence";
import {
  CREATOR_STALL_NUDGE_USER_MESSAGE,
  mainPyLooksLikePhase2Stub
} from "../src/creatorTurnGuard";
import { ProviderClient } from "../src/providerClient";
import { loadProviderConfig, validateProviderConfig } from "../src/providerConfig";
import { allowedDeferredSkillIdsForMode, resolveSkillRouterPrompt } from "../src/skillBundle";
import { SessionEngine } from "../src/sessionEngine";
import { WorkspacePolicy } from "../src/workspacePolicy";

const config = loadProviderConfig();
const canRunLive = validateProviderConfig(config).ok;

function buildFlipClockRoutedPrompt(workspacePath: string): string {
  const skillsDir = path.resolve(__dirname, "../skills");
  const template = fs.readFileSync(path.join(skillsDir, "widget-creator.md"), "utf-8");
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
    template,
    "",
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

describe.skipIf(!canRunLive)("flip-clock creator live e2e", () => {
  it(
    "scaffolds conf/main and implements behavior with tools (stall recovery allowed)",
    async () => {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-flip-clock-e2e-"));
      const skillsDir = path.resolve(__dirname, "../skills");
      const persistence = new AgentSessionPersistence(tempRoot);
      const events: AgentEvent[] = [];
      let streamedAssistant = "";
      let streamedReasoning = "";

      const engine = new SessionEngine({
        provider: new ProviderClient(config),
        workspacePolicy: new WorkspacePolicy(tempRoot),
        skillPrompt: resolveSkillRouterPrompt(skillsDir, "widget-creator"),
        skillLibrary: {
          skillsDir,
          allowedIds: allowedDeferredSkillIdsForMode("widget-creator")
        },
        hostReloadEmulatorHandler: async () => "reload_emulator ok (e2e noop)",
        sessionPersistence: persistence,
        sessionTemplateMode: "widget-creator",
        sessionSection: "widget-creator"
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
      const stillStub = mainPyLooksLikePhase2Stub(mainPy);
      expect(stillStub).toBe(false);

      const combinedAssistant = `${streamedAssistant}\n${response}`;
      expect(combinedAssistant.toLowerCase()).toMatch(/agent steps|phase 0|phase 1|conf\.json/);

      const transactions = parseTransactions(tempRoot);
      const stallTurns = transactions.filter((row) => row.type === "creator.stall_turn");
      const completionResponses = transactions.filter((row) => row.type === "completion.response");
      const reasoningOnlyStall = completionResponses.some(
        (row) =>
          row.toolCallCount === 0 &&
          typeof row.reasoningChars === "number" &&
          row.reasoningChars > 1500 &&
          row.workspaceHasConfJson === true &&
          row.workspaceHasMainPy === true
      );

      if (reasoningOnlyStall) {
        expect(stallTurns.length).toBeGreaterThan(0);
        const transcriptPath = path.join(tempRoot, ".dartsnut", "agent-session", "transcript.jsonl");
        if (fs.existsSync(transcriptPath)) {
          const transcript = fs.readFileSync(transcriptPath, "utf-8");
          expect(transcript).toContain(CREATOR_STALL_NUDGE_USER_MESSAGE.slice(0, 32));
        }
        const postStallToolUse = completionResponses.some(
          (row, index) =>
            index > 0 &&
            typeof row.toolCallCount === "number" &&
            row.toolCallCount > 0 &&
            row.workspaceHasMainPy === true
        );
        expect(postStallToolUse).toBe(true);
      }

      expect(events.some((event) => event.type === "final")).toBe(true);
      expect(streamedReasoning.length).toBeLessThan(80_000);
    },
    600_000
  );
});
