import type { DartsnutRunContext } from "../dartsnutRunContext";

export const DARTSNUT_AGENT_NAMES = {
  orchestrator: "DartsnutOrchestrator",
  infoGatherer: "InfoGatherer",
  widgetCreator: "WidgetCreator",
  gameCreator: "GameCreator",
  widgetModifier: "WidgetModifier",
  gameModifier: "GameModifier",
  surgicalFixer: "SurgicalFixer",
  assetApplier: "AssetApplier"
} as const;

export type DartsnutAgentName = (typeof DARTSNUT_AGENT_NAMES)[keyof typeof DARTSNUT_AGENT_NAMES];

export function isCreatorAgent(name: string | undefined): boolean {
  return name === DARTSNUT_AGENT_NAMES.widgetCreator || name === DARTSNUT_AGENT_NAMES.gameCreator;
}

export function isModificationAgent(name: string | undefined): boolean {
  return (
    name === DARTSNUT_AGENT_NAMES.widgetModifier ||
    name === DARTSNUT_AGENT_NAMES.gameModifier ||
    name === DARTSNUT_AGENT_NAMES.surgicalFixer
  );
}

export function handoffToInfoGathererEnabled(ctx: DartsnutRunContext): boolean {
  return !ctx.intakeReady && !ctx.artifacts.initialPassComplete && !ctx.assetApplierMode;
}

export function handoffToWidgetCreatorEnabled(ctx: DartsnutRunContext): boolean {
  return (
    ctx.intakeReady &&
    ctx.projectType === "widget" &&
    Boolean(ctx.widgetSize) &&
    !ctx.artifacts.initialPassComplete &&
    !ctx.assetApplierMode
  );
}

export function handoffToGameCreatorEnabled(ctx: DartsnutRunContext): boolean {
  return (
    ctx.intakeReady &&
    ctx.projectType === "game" &&
    !ctx.artifacts.initialPassComplete &&
    !ctx.assetApplierMode
  );
}

export function handoffToWidgetModifierEnabled(ctx: DartsnutRunContext): boolean {
  return ctx.artifacts.initialPassComplete && ctx.projectType === "widget" && !ctx.assetApplierMode;
}

export function handoffToGameModifierEnabled(ctx: DartsnutRunContext): boolean {
  return ctx.artifacts.initialPassComplete && ctx.projectType === "game" && !ctx.assetApplierMode;
}

export function handoffToSurgicalFixerEnabled(ctx: DartsnutRunContext): boolean {
  return ctx.artifacts.initialPassComplete && !ctx.assetApplierMode;
}

export function handoffToAssetApplierEnabled(ctx: DartsnutRunContext): boolean {
  return ctx.assetApplierMode || ctx.templateMode === "asset-applier";
}
