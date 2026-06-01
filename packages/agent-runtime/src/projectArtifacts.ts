import fs from "node:fs";
import path from "node:path";
import { readCreatorArtifactStatus } from "./creatorTurnGuard";

export interface ProjectArtifactStatus {
  confJson: boolean;
  mainPy: boolean;
  /** Both conf.json and main.py exist — initial scaffold is in place. */
  initialPassComplete: boolean;
}

export function readProjectArtifactStatus(workspacePath: string): ProjectArtifactStatus {
  const abs = path.resolve(workspacePath);
  try {
    const status = readCreatorArtifactStatus(
      (absolutePath) => fs.existsSync(absolutePath),
      (relativePath) => path.join(abs, relativePath)
    );
    return {
      ...status,
      initialPassComplete: status.confJson && status.mainPy
    };
  } catch {
    return { confJson: false, mainPy: false, initialPassComplete: false };
  }
}
