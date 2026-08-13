import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  collectReleaseArtifacts,
  createReleaseApi,
  loadReleaseConfig,
  normalizeVersionArgs,
  publishBuiltArtifacts,
  releaseTargetForPlatform,
  resolveWorkspaceVersion
} from "./publish_release_helpers.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runPackage(packageScript) {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const child = spawn(command, ["run", packageScript], {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed${signal ? ` (${signal})` : ` with exit code ${code}`}`));
    });
  });
}

function stage(message) {
  console.log(`[release] ${message}`);
}

try {
  const versionArgs = normalizeVersionArgs(process.argv.slice(2));
  const target = releaseTargetForPlatform(process.platform);
  const config = loadReleaseConfig(repoRoot);
  const version = resolveWorkspaceVersion(repoRoot, versionArgs);
  stage(`version ${version}, platform ${target.apiPlatform}`);

  const buildStartedAt = Date.now();
  stage(`running pnpm run ${target.packageScript}`);
  await runPackage(target.packageScript);
  stage("package complete");

  const artifacts = collectReleaseArtifacts(
    path.join(repoRoot, "apps", "desktop", "release"),
    target,
    version,
    buildStartedAt
  );
  stage("release artifacts validated");

  await publishBuiltArtifacts({
    api: createReleaseApi(config),
    target,
    version,
    artifacts,
    description: config.description,
    onStage: stage
  });
  stage("publish complete");
} catch (error) {
  console.error(`[release] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
