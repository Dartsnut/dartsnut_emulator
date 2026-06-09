import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  handoffToAssetApplierEnabled,
  handoffToGameCreatorEnabled,
  handoffToGameModifierEnabled,
  handoffToInfoGathererEnabled,
  handoffToSurgicalFixerEnabled,
  handoffToWidgetCreatorEnabled,
  handoffToWidgetModifierEnabled
} from "../src/agents/handoffGates";
import type { DartsnutRunContext } from "../src/dartsnutRunContext";

function ctx(partial: Partial<DartsnutRunContext>): DartsnutRunContext {
  return {
    workspacePath: partial.workspacePath ?? fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-gate-")),
    templateMode: partial.templateMode ?? null,
    intakeReady: partial.intakeReady ?? false,
    artifacts: partial.artifacts ?? { confJson: false, mainPy: false, initialPassComplete: false },
    assetApplierMode: partial.assetApplierMode ?? false,
    skillsDir: partial.skillsDir ?? path.join(process.cwd(), "skills"),
    preferredUserLocale: partial.preferredUserLocale ?? null,
    projectType: partial.projectType,
    widgetSize: partial.widgetSize
  };
}

describe("handoff gates", () => {
  it("routes intake when not ready", () => {
    expect(handoffToInfoGathererEnabled(ctx({ intakeReady: false }))).toBe(true);
    expect(handoffToInfoGathererEnabled(ctx({ intakeReady: true }))).toBe(false);
    expect(handoffToInfoGathererEnabled(ctx({ assetApplierMode: true }))).toBe(false);
  });

  it("blocks info gatherer after initial scaffold exists", () => {
    expect(
      handoffToInfoGathererEnabled(
        ctx({
          intakeReady: false,
          artifacts: { confJson: true, mainPy: true, initialPassComplete: true }
        })
      )
    ).toBe(false);
  });

  it("routes widget creator during initial scaffold when size is recorded", () => {
    const ready = ctx({
      intakeReady: true,
      projectType: "widget",
      widgetSize: "128x128",
      artifacts: { confJson: false, mainPy: false, initialPassComplete: false }
    });
    expect(handoffToWidgetCreatorEnabled(ready)).toBe(true);
    expect(handoffToGameCreatorEnabled(ready)).toBe(false);
  });

  it("blocks widget creator without widget size", () => {
    const ready = ctx({
      intakeReady: true,
      projectType: "widget",
      artifacts: { confJson: false, mainPy: false, initialPassComplete: false }
    });
    expect(handoffToWidgetCreatorEnabled(ready)).toBe(false);
  });

  it("routes game creator during initial scaffold", () => {
    const ready = ctx({
      intakeReady: true,
      projectType: "game",
      artifacts: { confJson: false, mainPy: false, initialPassComplete: false }
    });
    expect(handoffToGameCreatorEnabled(ready)).toBe(true);
    expect(handoffToWidgetCreatorEnabled(ready)).toBe(false);
  });

  it("routes modifiers after initial pass", () => {
    const complete = ctx({
      intakeReady: true,
      projectType: "widget",
      artifacts: { confJson: true, mainPy: true, initialPassComplete: true }
    });
    expect(handoffToWidgetCreatorEnabled(complete)).toBe(false);
    expect(handoffToWidgetModifierEnabled(complete)).toBe(true);
    expect(handoffToGameModifierEnabled(complete)).toBe(false);
    expect(handoffToSurgicalFixerEnabled(complete)).toBe(true);
  });

  it("routes asset applier mode exclusively", () => {
    const applier = ctx({ assetApplierMode: true, templateMode: "asset-applier" });
    expect(handoffToAssetApplierEnabled(applier)).toBe(true);
    expect(handoffToInfoGathererEnabled(applier)).toBe(false);
    expect(handoffToWidgetCreatorEnabled(applier)).toBe(false);
  });
});
