import fs from "node:fs";
import path from "node:path";
import { classifyDartsnutProjectFiles } from "@dartsnut/shared-ipc/dist/projectClassification";
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
    const pyprojectPath = path.join(abs, "pyproject.toml");
    const confPath = path.join(abs, "conf.json");
    const classification = classifyDartsnutProjectFiles(
      fs.existsSync(pyprojectPath) ? fs.readFileSync(pyprojectPath, "utf-8") : null,
      fs.existsSync(confPath) ? fs.readFileSync(confPath, "utf-8") : null
    );
    return { ...status, initialPassComplete: classification.ok && status.mainPy };
  } catch {
    return { confJson: false, mainPy: false, initialPassComplete: false };
  }
}
