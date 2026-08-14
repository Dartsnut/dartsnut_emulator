import type { ProjectType, UserLocale, WidgetSize } from "@dartsnut/shared-ipc";
import type { ProjectArtifactStatus } from "./projectArtifacts";
import { readProjectArtifactStatus } from "./projectArtifacts";
import { readWorkspaceCreatorHints } from "./projectRouting";

export type DartsnutTemplateMode =
  | "game-creator"
  | "widget-creator"
  | "asset-applier"
  | null;

/** Mutable SDK run context shared across orchestrator handoffs. */
export interface DartsnutRunContext {
  workspacePath: string;
  projectType?: ProjectType;
  widgetSize?: WidgetSize;
  templateMode: DartsnutTemplateMode;
  artifacts: ProjectArtifactStatus;
  assetApplierMode: boolean;
  skillsDir: string;
  preferredUserLocale: UserLocale | null;
  /** Original user message for the active prompt. */
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
  /** Original user prompt for creator continuation / handoff payloads. */
  originalUserPrompt?: string;
};

function resolveWorkspaceRouting(
  workspacePath: string,
  _artifacts: ProjectArtifactStatus
): Pick<DartsnutRunContext, "projectType" | "widgetSize"> {
  const hints = readWorkspaceCreatorHints(workspacePath);
  if (!hints) return {};
  return {
    projectType: hints.projectType,
    widgetSize: hints.widgetSize
  };
}

function mergeRouting(
  input: SeedDartsnutRunContextInput,
  artifacts: ProjectArtifactStatus
): Pick<DartsnutRunContext, "projectType" | "widgetSize"> {
  const templateMode = input.templateMode ?? null;
  const fromWorkspace = resolveWorkspaceRouting(input.workspacePath, artifacts);
  if (fromWorkspace.projectType) {
    return fromWorkspace;
  }
  return {
    projectType:
      input.projectType ??
      (templateMode === "widget-creator" ? "widget" : templateMode === "game-creator" ? "game" : undefined),
    widgetSize: input.widgetSize
  };
}

export function seedDartsnutRunContext(input: SeedDartsnutRunContextInput): DartsnutRunContext {
  const artifacts = readProjectArtifactStatus(input.workspacePath);
  const { projectType, widgetSize } = mergeRouting(input, artifacts);
  const templateMode = input.templateMode ?? null;
  return {
    workspacePath: input.workspacePath,
    projectType,
    widgetSize,
    templateMode,
    artifacts,
    assetApplierMode: input.assetApplierMode ?? templateMode === "asset-applier",
    skillsDir: input.skillsDir,
    preferredUserLocale: input.preferredUserLocale ?? null,
    originalUserPrompt: input.originalUserPrompt
  };
}

export function refreshDartsnutRunContext(ctx: DartsnutRunContext): void {
  ctx.artifacts = readProjectArtifactStatus(ctx.workspacePath);
  const fromWorkspace = resolveWorkspaceRouting(ctx.workspacePath, ctx.artifacts);
  if (fromWorkspace.projectType) {
    ctx.projectType = fromWorkspace.projectType;
    ctx.widgetSize = fromWorkspace.widgetSize;
  }
}

export function formatRunContextSnapshot(ctx: DartsnutRunContext): string {
  return JSON.stringify(
    {
      workspacePath: ctx.workspacePath,
      projectType: ctx.projectType ?? null,
      widgetSize: ctx.widgetSize ?? null,
      templateMode: ctx.templateMode,
      artifacts: ctx.artifacts,
      assetApplierMode: ctx.assetApplierMode,
      originalUserPrompt: ctx.originalUserPrompt ?? null
    },
    null,
    2
  );
}
