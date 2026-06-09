import type { ProjectType, UserLocale, WidgetSize } from "@dartsnut/shared-ipc";
import type { ProjectArtifactStatus } from "./projectArtifacts";
import { readProjectArtifactStatus } from "./projectArtifacts";
import {
  isIntakeStateReady,
  readWorkspaceCreatorHints,
  type IntakeToolState
} from "./creationIntakeHost";

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

function resolveWorkspaceIntakeHydration(
  workspacePath: string,
  artifacts: ProjectArtifactStatus
): Pick<DartsnutRunContext, "intakeReady" | "projectType" | "widgetSize"> {
  const hints = readWorkspaceCreatorHints(workspacePath);
  if (!hints) {
    return { intakeReady: false };
  }
  if (artifacts.initialPassComplete) {
    return {
      intakeReady: true,
      projectType: hints.projectType,
      widgetSize: hints.widgetSize
    };
  }
  const intakeReady = hints.projectType === "game" || Boolean(hints.widgetSize);
  return {
    intakeReady,
    projectType: hints.projectType,
    widgetSize: hints.widgetSize
  };
}

function mergeIntakeRouting(
  input: SeedDartsnutRunContextInput,
  artifacts: ProjectArtifactStatus
): Pick<DartsnutRunContext, "intakeReady" | "projectType" | "widgetSize"> {
  const templateMode = input.templateMode ?? null;
  const fromHostState =
    input.hostIntakeReadyToFinish?.() ??
    (input.intakeState ? isIntakeStateReady(input.intakeState) : false);
  if (fromHostState) {
    return {
      intakeReady: true,
      projectType:
        input.intakeState?.projectType ??
        input.projectType ??
        (templateMode === "widget-creator" ? "widget" : templateMode === "game-creator" ? "game" : undefined),
      widgetSize: input.intakeState?.widgetSize ?? input.widgetSize
    };
  }
  const fromWorkspace = resolveWorkspaceIntakeHydration(input.workspacePath, artifacts);
  if (fromWorkspace.intakeReady) {
    return fromWorkspace;
  }
  return {
    intakeReady: false,
    projectType: input.projectType,
    widgetSize: input.widgetSize
  };
}

export function seedDartsnutRunContext(input: SeedDartsnutRunContextInput): DartsnutRunContext {
  const artifacts = readProjectArtifactStatus(input.workspacePath);
  const { intakeReady, projectType, widgetSize } = mergeIntakeRouting(input, artifacts);
  const templateMode = input.templateMode ?? null;
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
  const hostReady =
    (intakeState ? isIntakeStateReady(intakeState) : false) ||
    (hostIntakeReadyToFinish?.() ?? false);
  if (hostReady && intakeState) {
    ctx.intakeReady = true;
    ctx.projectType = intakeState.projectType;
    ctx.widgetSize = intakeState.widgetSize;
    return;
  }
  const fromWorkspace = resolveWorkspaceIntakeHydration(ctx.workspacePath, ctx.artifacts);
  if (fromWorkspace.intakeReady) {
    ctx.intakeReady = true;
    ctx.projectType = fromWorkspace.projectType;
    ctx.widgetSize = fromWorkspace.widgetSize;
    return;
  }
  ctx.intakeReady = false;
  ctx.projectType = undefined;
  ctx.widgetSize = undefined;
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
