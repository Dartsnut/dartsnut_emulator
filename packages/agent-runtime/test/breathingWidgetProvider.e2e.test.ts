import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmProviderId } from "@dartsnut/shared-ipc";
import {
  BUILTIN_E2E_PROVIDERS,
  canRunProviderE2e,
  compareFlowToBaseline,
  ensureE2eRepoRoot,
  flowResultToBaseline,
  providerConfigForE2e,
  e2eTimeoutMsForProvider,
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
      `Missing baseline fixture at ${BASELINE_PATH}. Run with UPDATE_E2E_BASELINE=1 and xiaomi credentials to generate.`
    );
  }
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8")) as BreathingWidgetE2eBaseline;
}

function writeBaseline(baseline: BreathingWidgetE2eBaseline): void {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, "utf-8");
}

describe.sequential("breathing widget provider parity e2e", () => {
  ensureE2eRepoRoot();

  describe("xiaomi baseline", () => {
    const providerId: LlmProviderId = "xiaomi";
    const canRun = canRunProviderE2e(providerId);

    it.skipIf(!canRun)(
      UPDATE_BASELINE ? "records baseline fixture" : "matches committed baseline",
      async () => {
        const config = providerConfigForE2e(providerId);
        const result = await runBreathingWidgetFlow(providerId, config);
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
      e2eTimeoutMsForProvider(providerId)
    );
  });

  const otherProviders = BUILTIN_E2E_PROVIDERS.filter((id) => id !== "xiaomi");

  for (const providerId of otherProviders) {
    describe(`${providerId} vs xiaomi`, () => {
      const canRun = canRunProviderE2e(providerId);
      const baselineExists = fs.existsSync(BASELINE_PATH);

      it.skipIf(!canRun || !baselineExists)(
        "matches xiaomi baseline behavior",
        async () => {
          const config = providerConfigForE2e(providerId);
          const result = await runBreathingWidgetFlow(providerId, config);
          const baseline = loadBaseline();
          const errors = compareFlowToBaseline(result, baseline);
          expect(errors, `${providerId}:\n${errors.join("\n")}`).toEqual([]);
        },
        e2eTimeoutMsForProvider(providerId)
      );
    });
  }
});
