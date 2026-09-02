import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = process.env.DARTSNUT_PYTHON_RUNTIME_SOURCE
  ? path.resolve(process.env.DARTSNUT_PYTHON_RUNTIME_SOURCE)
  : path.join(repoRoot, "apps", "desktop", "resources", "python-runtime");
const output = process.env.DARTSNUT_PYTHON_RUNTIME_OUTPUT
  ? path.resolve(process.env.DARTSNUT_PYTHON_RUNTIME_OUTPUT)
  : path.join(repoRoot, "apps", "desktop", "resources", "python-runtime");

async function isDirectory(value) {
  try {
    return (await fs.stat(value)).isDirectory();
  } catch {
    return false;
  }
}

if (!(await isDirectory(source))) {
  throw new Error(`Bundled Python runtime source missing: ${source}. Set DARTSNUT_PYTHON_RUNTIME_SOURCE to a prepared platform runtime.`);
}

if (path.resolve(source) !== path.resolve(output)) {
  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.cp(source, output, { recursive: true, dereference: true });
}

const manifest = {
  platform: process.platform,
  arch: process.arch,
  source,
  generatedAt: new Date().toISOString()
};
await fs.writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Bundled Python runtime: ${output}`);
