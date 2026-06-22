import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PUBLISH_ALLOWED_ROOT_FILES = new Set(["conf.json", "pyproject.toml"]);
const PUBLISH_ALLOWED_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".avif",
  ".bmp",
  ".flac",
  ".gif",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mid",
  ".midi",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".png",
  ".py",
  ".svg",
  ".wav",
  ".webp"
]);
const PUBLISH_SKIP_DIRECTORIES = new Set([
  ".dartsnut",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "venv"
]);

export function isPublishAllowedFile(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const baseName = path.basename(normalized).toLowerCase();
  if (!normalized.includes("/") && PUBLISH_ALLOWED_ROOT_FILES.has(baseName)) {
    return true;
  }
  return PUBLISH_ALLOWED_EXTENSIONS.has(path.extname(baseName));
}

export function stagePublishWorkspace(workspacePath: string): { stagePath: string; fileCount: number } {
  const stagePath = fs.mkdtempSync(path.join(os.tmpdir(), "dartsnut-publish-stage-"));
  let fileCount = 0;
  const walk = (absoluteDir: string) => {
    const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (PUBLISH_SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }
        walk(path.join(absoluteDir, entry.name));
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const absoluteSource = path.join(absoluteDir, entry.name);
      const relativePath = path.relative(workspacePath, absoluteSource);
      if (!isPublishAllowedFile(relativePath)) {
        continue;
      }
      const absoluteDest = path.join(stagePath, relativePath);
      fs.mkdirSync(path.dirname(absoluteDest), { recursive: true });
      fs.copyFileSync(absoluteSource, absoluteDest);
      fileCount += 1;
    }
  };
  walk(workspacePath);
  return { stagePath, fileCount };
}

export function createPublishTarball(workspacePath: string, appId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let stagePath: string;
    let fileCount: number;
    try {
      const stage = stagePublishWorkspace(workspacePath);
      stagePath = stage.stagePath;
      fileCount = stage.fileCount;
      if (fileCount === 0) {
        fs.rmSync(stagePath, { recursive: true, force: true });
        reject(new Error("No publishable files found in the workspace."));
        return;
      }
    } catch (error) {
      reject(error);
      return;
    }
    const outFile = path.join(os.tmpdir(), `dartsnut-publish-${appId}-${Date.now()}.tar.gz`);
    const env = { ...process.env, COPYFILE_DISABLE: "1" };
    const child = spawn(
      "tar",
      [
        "-c",
        "--format",
        "ustar",
        "-z",
        "-f",
        outFile,
        "-C",
        stagePath,
        "."
      ],
      { stdio: "ignore", env }
    );
    const cleanupStage = () => {
      fs.rm(stagePath, { recursive: true, force: true }, () => {});
    };
    child.on("error", (err: NodeJS.ErrnoException) => {
      cleanupStage();
      if (err.code === "ENOENT") {
        reject(new Error("Could not run `tar` on PATH to package the app workspace."));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      cleanupStage();
      if (code === 0) {
        resolve(outFile);
      } else {
        reject(new Error(`tar exited with code ${code}`));
      }
    });
  });
}
