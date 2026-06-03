import type { ProjectType, UserLocale, WidgetSize } from "@dartsnut/shared-ipc";
import type { ProjectArtifactStatus } from "./projectArtifacts";
import { readProjectArtifactStatus } from "./projectArtifacts";
import { isIntakeStateReady, type IntakeToolState } from "./creationIntakeHost";

export type DartsnutTemplateMode =
  | "game-creator"
  | "widget-creator"
  | "asset-applier"
  | "creation-intake"
  | null;

/** Mutable SDK run context shared across orchestrator handoffs. */
export interface DartsnutRunContext {
  workspacePath: string;
  projectType?: ProjectType;
  widgetSize?: WidgetSize;
  templateMode: DartsnutTemplateMode;
  intakeReady: boolean;
  artifacts: ProjectArtifactStatus;
  assetApplierMode: boolean;
  skillsDir: string;
  preferredUserLocale: UserLocale | null;
  /** Original user message for the active prompt (creator continuation after intake). */
  originalUserPrompt?: string;
  /** Last active specialist agent name (updated by event bridge). */
  activeAgentName?: string;
}

export type SeedDartsnutRunContextInput = {
  workspacePath: string;
  skillsDir: string;
  preferredUserLocale?: UserLocale | null;
  projectType?: ProjectType;
  widgetSize?: WidgetSize;
  templateMode?: DartsnutTemplateMode;
  assetApplierMode?: boolean;
  intakeState?: IntakeToolState;
  hostIntakeReadyToFinish?: () => boolean;
  /** Original user prompt for creator continuation / handoff payloads. */
  originalUserPrompt?: string;
};

export function seedDartsnutRunContext(input: SeedDartsnutRunContextInput): DartsnutRunContext {
  const intakeReady =
    input.hostIntakeReadyToFinish?.() ??
    (input.intakeState ? isIntakeStateReady(input.intakeState) : false);
  const artifacts = readProjectArtifactStatus(input.workspacePath);
  const templateMode = input.templateMode ?? null;
  const projectType = intakeReady
    ? (input.intakeState?.projectType ??
      input.projectType ??
      (templateMode === "widget-creator" ? "widget" : templateMode === "game-creator" ? "game" : undefined))
    : undefined;
  const widgetSize = intakeReady
    ? (input.intakeState?.widgetSize ?? input.widgetSize)
    : undefined;
  return {
    workspacePath: input.workspacePath,
    projectType,
    widgetSize,
    templateMode,
    intakeReady,
    artifacts,
    assetApplierMode: input.assetApplierMode ?? templateMode === "asset-applier",
    skillsDir: input.skillsDir,
    preferredUserLocale: input.preferredUserLocale ?? null,
    originalUserPrompt: input.originalUserPrompt
  };
}

export function refreshDartsnutRunContext(
  ctx: DartsnutRunContext,
  hostIntakeReadyToFinish?: () => boolean,
  intakeState?: IntakeToolState
): void {
  ctx.artifacts = readProjectArtifactStatus(ctx.workspacePath);
  if (intakeState) {
    const ready = isIntakeStateReady(intakeState);
    ctx.intakeReady = ready;
    if (ready) {
      ctx.projectType = intakeState.projectType;
      ctx.widgetSize = intakeState.widgetSize;
    } else {
      ctx.projectType = undefined;
      ctx.widgetSize = undefined;
    }
  } else if (hostIntakeReadyToFinish) {
    const ready = hostIntakeReadyToFinish();
    ctx.intakeReady = ready;
    if (!ready) {
      ctx.projectType = undefined;
      ctx.widgetSize = undefined;
    }
  }
  if (ctx.intakeReady && intakeState) {
    ctx.projectType = intakeState.projectType;
    ctx.widgetSize = intakeState.widgetSize;
  }
}

export function formatRunContextSnapshot(ctx: DartsnutRunContext): string {
  return JSON.stringify(
    {
      workspacePath: ctx.workspacePath,
      projectType: ctx.projectType ?? null,
      widgetSize: ctx.widgetSize ?? null,
      templateMode: ctx.templateMode,
      intakeReady: ctx.intakeReady,
      artifacts: ctx.artifacts,
      assetApplierMode: ctx.assetApplierMode,
      originalUserPrompt: ctx.originalUserPrompt ?? null
    },
    null,
    2
  );
}
