import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requirementsPath = path.join(repoRoot, "requirements.txt");
const runtimeOutputDir = path.join(repoRoot, "apps", "desktop", "resources", "python-runtime");
const uvOutputDir = path.join(repoRoot, "apps", "desktop", "resources", "uv");

const PYTHON_RELEASE = "20241016";
const PYTHON_VERSION = "3.12.7";
const PYTHON_BASE_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_RELEASE}`;

const UV_VERSION = "0.11.19";
const UV_BASE_URL = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;

/** @type {Record<string, { archive: string; standalonePythonRel: string }>} */
const PYTHON_TARGETS = {
  "darwin-arm64": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-aarch64-apple-darwin-install_only_stripped.tar.gz`,
    standalonePythonRel: "python/bin/python3",
  },
  "win-x64": {
    archive: `cpython-${PYTHON_VERSION}+${PYTHON_RELEASE}-x86_64-pc-windows-msvc-shared-install_only_stripped.tar.gz`,
    standalonePythonRel: "python/python.exe",
  },
};

/** @type {Record<string, { archive: string; archiveKind: "tar.gz" | "zip"; uvRel: string }>} */
const UV_TARGETS = {
  "darwin-arm64": {
    archive: `uv-aarch64-apple-darwin.tar.gz`,
    archiveKind: "tar.gz",
    uvRel: "uv-aarch64-apple-darwin/uv",
  },
  "win-x64": {
    archive: `uv-x86_64-pc-windows-msvc.zip`,
    archiveKind: "zip",
    uvRel: "uv.exe",
  },
};

function parseArgs(argv) {
  let target = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target" && argv[i + 1]) {
      target = argv[i + 1];
      i += 1;
    }
  }
  return { target };
}

function detectTarget() {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return "darwin-arm64";
    }
    throw new Error(`Unsupported macOS arch for bundled Python: ${process.arch}`);
  }
  if (process.platform === "win32") {
    if (process.arch === "x64") {
      return "win-x64";
    }
    throw new Error(`Unsupported Windows arch for bundled Python: ${process.arch}`);
  }
  throw new Error(
    `Bundled Python build is only supported on macOS arm64 and Windows x64 (got ${process.platform}/${process.arch}).`,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function venvPythonPath(venvDir) {
  if (process.platform === "win32") {
    return path.join(venvDir, "Scripts", "python.exe");
  }
  return path.join(venvDir, "bin", "python");
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return bytes;
}

async function verifySha256(archivePath, checksumUrl) {
  const response = await fetch(checksumUrl);
  if (!response.ok) {
    console.warn(`Skipping SHA256 verification (missing ${checksumUrl}).`);
    return;
  }
  const expected = (await response.text()).trim().split(/\s+/)[0];
  const actual = crypto.createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
  if (expected !== actual) {
    throw new Error(`SHA256 mismatch for ${path.basename(archivePath)}`);
  }
}

function extractTarGz(archivePath, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  run("tar", ["-xzf", archivePath, "-C", extractDir]);
}

function extractZip(archivePath, extractDir) {
  fs.mkdirSync(extractDir, { recursive: true });
  if (process.platform === "win32") {
    run("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -Path '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
    ]);
    return;
  }
  run("unzip", ["-oq", archivePath, "-d", extractDir]);
}

async function ensureUvBinary(target) {
  const uvConfig = UV_TARGETS[target];
  const cacheDir = path.join(repoRoot, ".cache", "uv", UV_VERSION);
  const archivePath = path.join(cacheDir, uvConfig.archive);
  const extractDir = path.join(cacheDir, "extracted");

  if (!fs.existsSync(archivePath)) {
    const archiveUrl = `${UV_BASE_URL}/${uvConfig.archive}`;
    console.log(`Downloading ${archiveUrl}`);
    await downloadFile(archiveUrl, archivePath);
  } else {
    console.log(`Using cached uv archive ${archivePath}`);
  }

  await verifySha256(archivePath, `${UV_BASE_URL}/${uvConfig.archive}.sha256`);

  if (fs.existsSync(uvOutputDir)) {
    fs.rmSync(uvOutputDir, { recursive: true, force: true });
  }
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  console.log("Extracting uv...");
  if (uvConfig.archiveKind === "zip") {
    extractZip(archivePath, extractDir);
  } else {
    extractTarGz(archivePath, extractDir);
  }

  const extractedUv = path.join(extractDir, uvConfig.uvRel);
  if (!fs.existsSync(extractedUv)) {
    throw new Error(`Expected uv binary at ${extractedUv}`);
  }

  fs.mkdirSync(uvOutputDir, { recursive: true });
  const uvBinName = process.platform === "win32" ? "uv.exe" : "uv";
  const destUv = path.join(uvOutputDir, uvBinName);
  fs.copyFileSync(extractedUv, destUv);
  if (process.platform !== "win32") {
    fs.chmodSync(destUv, 0o755);
  }

  const marker = {
    target,
    uvVersion: UV_VERSION,
    builtAt: new Date().toISOString(),
    host: `${os.platform()}/${os.arch()}`,
  };
  fs.writeFileSync(path.join(uvOutputDir, ".bundled-uv.json"), `${JSON.stringify(marker, null, 2)}\n`);
  console.log(`Bundled uv ready at ${destUv}`);
  return destUv;
}

async function main() {
  const { target: targetArg } = parseArgs(process.argv.slice(2));
  const target = targetArg ?? detectTarget();
  const pythonConfig = PYTHON_TARGETS[target];
  if (!pythonConfig) {
    throw new Error(`Unknown target "${target}". Expected one of: ${Object.keys(PYTHON_TARGETS).join(", ")}`);
  }
  if (!fs.existsSync(requirementsPath)) {
    throw new Error(`Missing requirements.txt at ${requirementsPath}`);
  }

  const uvBin = await ensureUvBinary(target);

  const cacheDir = path.join(repoRoot, ".cache", "python-build-standalone");
  const archivePath = path.join(cacheDir, pythonConfig.archive);
  const extractDir = path.join(cacheDir, target, "extracted");
  const standalonePython = path.join(extractDir, pythonConfig.standalonePythonRel);
  const runtimePython = venvPythonPath(runtimeOutputDir);

  console.log(`Building bundled Python runtime for ${target}...`);
  fs.mkdirSync(cacheDir, { recursive: true });

  if (!fs.existsSync(archivePath)) {
    const archiveUrl = `${PYTHON_BASE_URL}/${pythonConfig.archive}`;
    console.log(`Downloading ${archiveUrl}`);
    await downloadFile(archiveUrl, archivePath);
  } else {
    console.log(`Using cached archive ${archivePath}`);
  }

  await verifySha256(archivePath, `${PYTHON_BASE_URL}/${pythonConfig.archive}.sha256`);

  if (fs.existsSync(runtimeOutputDir)) {
    fs.rmSync(runtimeOutputDir, { recursive: true, force: true });
  }
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }

  console.log("Extracting standalone Python...");
  extractTarGz(archivePath, extractDir);
  if (!fs.existsSync(standalonePython)) {
    throw new Error(`Expected standalone interpreter at ${standalonePython}`);
  }

  console.log("Creating virtual environment with uv...");
  run(uvBin, ["venv", "--python", standalonePython, runtimeOutputDir], { cwd: repoRoot });

  if (!fs.existsSync(runtimePython)) {
    throw new Error(`Expected venv interpreter at ${runtimePython}`);
  }

  // Fix python symlinks in the venv bin directory that point outside the bundle.
  // uv venv creates bin/python -> <absolute-path-to-standalone-cache>/python3 which
  // codesign --verify --deep --strict rejects.  We copy the real interpreter binary
  // into the venv's bin dir and repoint all python* symlinks at it so the whole
  // runtime is self-contained.
  if (process.platform !== "win32") {
    console.log("Fixing python symlinks in venv bin...");
    const binDir = path.join(runtimeOutputDir, "bin");

    // Resolve the chain of symlinks to find the real interpreter binary.
    // standalonePython = <cache>/python/bin/python3 (a real file, not a symlink)
    const realPythonSrc = fs.realpathSync(standalonePython);

    // Copy the real binary into the venv bin dir under its versioned name.
    // Remove any existing entry first (it may be a symlink like python3.12 -> python).
    const versionedName = `python${PYTHON_VERSION.split(".").slice(0, 2).join(".")}`;
    const versionedDest = path.join(binDir, versionedName);
    try { fs.unlinkSync(versionedDest); } catch { /* may not exist */ }
    console.log(`  Copying ${realPythonSrc} -> ${versionedDest}`);
    fs.copyFileSync(realPythonSrc, versionedDest);
    fs.chmodSync(versionedDest, 0o755);

    // The standalone Python binary is dynamically linked to libpython3.12.dylib via
    // @executable_path/../lib/libpython3.12.dylib.  Copy the dylib into the venv's lib/
    // dir so the binary can find it when run from inside the app bundle.
    const standaloneLibDir = path.join(path.dirname(path.dirname(realPythonSrc)), "lib");
    const dylibName = `libpython${PYTHON_VERSION.split(".").slice(0, 2).join(".")}.dylib`;
    const dylibSrc = path.join(standaloneLibDir, dylibName);
    if (fs.existsSync(dylibSrc)) {
      const venvLibDir = path.join(runtimeOutputDir, "lib");
      fs.mkdirSync(venvLibDir, { recursive: true });
      const dylibDest = path.join(venvLibDir, dylibName);
      console.log(`  Copying ${dylibSrc} -> ${dylibDest}`);
      fs.copyFileSync(dylibSrc, dylibDest);
      fs.chmodSync(dylibDest, 0o755);
      // Fix the dylib's own install name so codesign is happy.
      run("install_name_tool", ["-id", `@executable_path/../lib/${dylibName}`, dylibDest]);
      // Fix the binary's reference to the dylib.
      run("install_name_tool", [
        "-change", `/install/lib/${dylibName}`,
        `@executable_path/../lib/${dylibName}`,
        versionedDest,
      ]);
    } else {
      console.log(`  Warning: ${dylibSrc} not found, skipping dylib copy`);
    }

    // Repoint python and python3 symlinks to the copied binary (versionedName is now a real file).
    for (const alias of ["python", "python3"]) {
      const linkPath = path.join(binDir, alias);
      try { fs.unlinkSync(linkPath); } catch { /* may not exist */ }
      fs.symlinkSync(versionedName, linkPath);
      console.log(`  ${alias} -> ${versionedName}`);
    }

    // Copy the Python stdlib from the standalone distribution into the venv's lib/ dir.
    // Without this, Python in the packaged app cannot find its standard library and fails
    // with "Could not find platform independent libraries <prefix>".
    const pyMinor = PYTHON_VERSION.split(".").slice(0, 2).join(".");
    const stdlibSrc = path.join(standaloneLibDir, `python${pyMinor}`);
    if (fs.existsSync(stdlibSrc)) {
      const venvLibDir = path.join(runtimeOutputDir, "lib");
      fs.mkdirSync(venvLibDir, { recursive: true });
      const stdlibDest = path.join(venvLibDir, `python${pyMinor}`);
      console.log(`  Copying stdlib ${stdlibSrc} -> ${stdlibDest}`);
      // Remove destination first: if uv venv already created lib/python3.12/ (with
      // just site-packages), cp -a would merge into it rather than replace it, leaving
      // the stdlib modules (encodings, etc.) missing.
      if (fs.existsSync(stdlibDest)) {
        fs.rmSync(stdlibDest, { recursive: true, force: true });
      }
      // Use cp -a to preserve permissions and symlinks inside the stdlib.
      run("cp", ["-a", stdlibSrc, stdlibDest]);
      // Remove __pycache__ dirs: Python writes .pyc files on first import, which would
      // modify files inside the signed .app bundle and break codesign --verify.
      // Starting with an empty cache means Python regenerates them at runtime outside
      // the sealed bundle (or we suppress writes via PYTHONDONTWRITEBYTECODE).
      run("find", [stdlibDest, "-type", "d", "-name", "__pycache__", "-exec", "rm", "-rf", "{}", "+"]);
      console.log(`  Stripped __pycache__ from stdlib`);
    } else {
      console.warn(`  Warning: stdlib not found at ${stdlibSrc}`);
    }

    // Fix pyvenv.cfg: the 'home' key points to the dev-machine standalone cache path.
    // Rewrite it to point to the venv's own bin/ so Python can locate itself in the
    // packaged app without any reference to the build machine's filesystem.
    const pyvenvCfg = path.join(runtimeOutputDir, "pyvenv.cfg");
    if (fs.existsSync(pyvenvCfg)) {
      let cfg = fs.readFileSync(pyvenvCfg, "utf8");
      cfg = cfg.replace(/^home\s*=\s*.+$/m, `home = ${binDir}`);
      fs.writeFileSync(pyvenvCfg, cfg);
      console.log(`  Fixed pyvenv.cfg home -> ${binDir}`);
    }
  }

  // The python-build-standalone binary has /install hardcoded as sys.base_prefix.
  // Setting PYTHONHOME to runtimeOutputDir makes Python find its stdlib at
  // <runtimeOutputDir>/lib/python3.12 instead of /install/lib/python3.12.
  const pythonEnv = { ...process.env, PYTHONHOME: runtimeOutputDir };

  console.log("Installing emulator dependencies with uv...");
  run(uvBin, ["pip", "install", "--python", runtimePython, "-r", requirementsPath], {
    cwd: repoRoot,
    env: pythonEnv,
  });

  console.log("Verifying bundled runtime...");
  run(
    runtimePython,
    ["-c", "import sys; import pydartsnut, pygame, PIL; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
    { cwd: repoRoot, env: pythonEnv },
  );

  console.log("Verifying uv run launcher...");
  run(
    uvBin,
    [
      "run",
      "--no-project",
      "--python",
      runtimePython,
      "python",
      "-c",
      "import pydartsnut, pygame, PIL; print('uv-run-ok')",
    ],
    {
      cwd: repoRoot,
      env: (() => {
        const env = {
          ...process.env,
          PYTHONHOME: runtimeOutputDir,
          UV_NO_PYTHON_DOWNLOADS: "never",
          UV_NO_MANAGED_PYTHON: "1",
          UV_NO_PROJECT: "1",
          UV_PYTHON: runtimePython,
          VIRTUAL_ENV: runtimeOutputDir,
        };
        delete env.UV_NO_SYNC;
        return env;
      })(),
    },
  );

  const marker = {
    target,
    pythonVersion: PYTHON_VERSION,
    pythonRelease: PYTHON_RELEASE,
    uvVersion: UV_VERSION,
    builtAt: new Date().toISOString(),
    host: `${os.platform()}/${os.arch()}`,
  };
  fs.writeFileSync(path.join(runtimeOutputDir, ".bundled-python.json"), `${JSON.stringify(marker, null, 2)}\n`);

  console.log(`Bundled Python runtime ready at ${runtimeOutputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
