import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canRunProviderE2e,
  compareFlowToBaseline,
  ensureE2eRepoRoot,
  flowResultToBaseline,
  providerConfigForE2e,
  e2eTimeoutMs,
  runBreathingWidgetFlow,
  type BreathingWidgetE2eBaseline
} from "./helpers/breathingWidgetProviderE2e";

const BASELINE_PATH = path.resolve(
  __dirname,
  "fixtures/e2e/breathing-widget-xiaomi-baseline.json"
);
const UPDATE_BASELINE = process.env.UPDATE_E2E_BASELINE === "1";

function loadBaseline(): BreathingWidgetE2eBaseline {
  if (!fs.existsSync(BASELINE_PATH)) {
    throw new Error(
      `Missing baseline fixture at ${BASELINE_PATH}. Run with UPDATE_E2E_BASELINE=1 and configured LLM credentials to generate.`
    );
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8")) as BreathingWidgetE2eBaseline;
}

function writeBaseline(baseline: BreathingWidgetE2eBaseline): void {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
}

describe.sequential("breathing widget provider e2e", () => {
  ensureE2eRepoRoot();

  const canRun = canRunProviderE2e();

  it.skipIf(!canRun)(
    UPDATE_BASELINE ? "records baseline fixture" : "matches committed baseline",
    async () => {
      const config = providerConfigForE2e();
      const result = await runBreathingWidgetFlow(config);
      const baselineShape = flowResultToBaseline(result);

      if (UPDATE_BASELINE) {
        writeBaseline(baselineShape);
        expect(fs.existsSync(BASELINE_PATH)).toBe(true);
        return;
      }

      const baseline = loadBaseline();
      const errors = compareFlowToBaseline(result, baseline, {
        compareReasoning: true,
        compareCreatorToolOrderToBaseline: true
      });
      expect(errors, errors.join("\n")).toEqual([]);
    },
    e2eTimeoutMs()
  );
});
