import path from "node:path";
import { readProjectArtifactStatus } from "./projectArtifacts";

export type WorkflowKind = "creation" | "modification";

export interface WorkflowRouteDecision {
  kind: WorkflowKind;
  workspacePath: string;
  confExists: boolean;
  mainPyExists: boolean;
  initialPassComplete: boolean;
}

/**
 * Route to creation until conf.json and main.py exist (initial scaffold pass).
 * Route to modification once the project artifacts are in place.
 *
 * Non-project files (e.g. `.dartsnut/agent-session`) do not force modification.
 */
export function decideWorkflowRoute(workspacePath: string): WorkflowRouteDecision {
  const abs = path.resolve(workspacePath);
  const artifacts = readProjectArtifactStatus(abs);
  return {
    kind: artifacts.initialPassComplete ? "modification" : "creation",
    workspacePath: abs,
    confExists: artifacts.confJson,
    mainPyExists: artifacts.mainPy,
    initialPassComplete: artifacts.initialPassComplete
  };
}
