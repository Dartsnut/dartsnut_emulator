import fs from "node:fs";
import path from "node:path";

export const VERSION_MANIFESTS = [
  "package.json",
  "apps/desktop/package.json",
  "packages/agent-runtime/package.json",
  "packages/emulator-protocol/package.json",
  "packages/shared-ipc/package.json"
];

const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function normalizeVersionArgs(args) {
  if (args[0] === "--") args = args.slice(1);
  if (args.length > 1) {
    throw new Error("Usage: pnpm release:publish -- [exact-semver]");
  }
  if (args[0] !== undefined && !EXACT_SEMVER.test(args[0])) {
    throw new Error(`Invalid exact SemVer: ${args[0]}`);
  }
  return args;
}

export function resolveWorkspaceVersion(repoRoot, args) {
  args = normalizeVersionArgs(args);

  const manifests = VERSION_MANIFESTS.map((relativePath) => {
    const filePath = path.join(repoRoot, relativePath);
    return { relativePath, filePath, data: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  });
  const requestedVersion = args[0];

  if (requestedVersion !== undefined) {
    for (const manifest of manifests) {
      manifest.data.version = requestedVersion;
    }
    for (const manifest of manifests) {
      fs.writeFileSync(manifest.filePath, `${JSON.stringify(manifest.data, null, 2)}\n`);
    }
    return requestedVersion;
  }

  const versions = new Map();
  for (const manifest of manifests) {
    const version = String(manifest.data.version || "");
    const files = versions.get(version) || [];
    files.push(manifest.relativePath);
    versions.set(version, files);
  }
  if (versions.size !== 1) {
    const details = [...versions.entries()]
      .map(([version, files]) => `${version || "<missing>"}: ${files.join(", ")}`)
      .join("; ");
    throw new Error(`Workspace package versions do not match: ${details}`);
  }
  const version = manifests[0].data.version;
  if (!EXACT_SEMVER.test(version)) {
    throw new Error(`Workspace version is not exact SemVer: ${version}`);
  }
  return version;
}

export function releaseTargetForPlatform(platform) {
  if (platform === "darwin") {
    return {
      platform: "darwin",
      apiPlatform: "mac",
      packageScript: "package:mac",
      installerExtension: ".dmg",
      metadataFile: "latest-mac.yml",
      updateExtension: ".zip"
    };
  }
  if (platform === "win32") {
    return {
      platform: "win32",
      apiPlatform: "windows",
      packageScript: "package:win",
      installerExtension: ".exe",
      metadataFile: "latest.yml",
      updateExtension: ".exe"
    };
  }
  throw new Error(`Unsupported release platform: ${platform}`);
}

function versionPattern(version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^0-9A-Za-z])${escaped}(?=$|[^0-9A-Za-z])`);
}

function oneVersionedFile(files, version, extension, label) {
  const pattern = versionPattern(version);
  const matches = files.filter((name) => name.endsWith(extension) && pattern.test(name));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} for version ${version}; found ${matches.length}`);
  }
  return matches[0];
}

function assertFresh(filePath, buildStartedAt) {
  const modifiedAt = fs.statSync(filePath).mtimeMs;
  if (modifiedAt < buildStartedAt - 2000) {
    throw new Error(`Release artifact is stale: ${path.basename(filePath)}`);
  }
}

export function collectReleaseArtifacts(releaseDir, target, version, buildStartedAt = 0) {
  if (!fs.existsSync(releaseDir)) {
    throw new Error(`Release directory does not exist: ${releaseDir}`);
  }
  const files = fs.readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);

  const installerName = oneVersionedFile(files, version, target.installerExtension, "installer");
  const updateBinaryName = target.updateExtension === target.installerExtension
    ? installerName
    : oneVersionedFile(files, version, target.updateExtension, "update binary");
  const blockmapName = `${updateBinaryName}.blockmap`;
  if (!files.includes(blockmapName)) {
    throw new Error(`Missing live-update blockmap: ${blockmapName}`);
  }
  if (!files.includes(target.metadataFile)) {
    throw new Error(`Missing live-update metadata: ${target.metadataFile}`);
  }

  const artifacts = {
    installer: path.join(releaseDir, installerName),
    liveUpdateFiles: [
      path.join(releaseDir, updateBinaryName),
      path.join(releaseDir, blockmapName),
      path.join(releaseDir, target.metadataFile)
    ]
  };
  for (const filePath of new Set([artifacts.installer, ...artifacts.liveUpdateFiles])) {
    assertFresh(filePath, buildStartedAt);
  }

  const metadata = fs.readFileSync(path.join(releaseDir, target.metadataFile), "utf8");
  if (!metadata.includes(updateBinaryName)) {
    throw new Error(`${target.metadataFile} does not reference ${updateBinaryName}`);
  }
  return artifacts;
}

/** Collect Tauri 2 bundle/update artifacts from a bundle output directory. */
export function collectTauriArtifacts(bundleRoot, target, version, buildStartedAt = 0) {
  if (!fs.existsSync(bundleRoot)) throw new Error(`Tauri bundle directory does not exist: ${bundleRoot}`);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(filePath);
      else files.push({ name: entry.name, path: filePath });
    }
  };
  walk(bundleRoot);
  const names = files.map(({ name }) => name);
  const installerExt = target.platform === "darwin" ? ".dmg" : ".exe";
  const installerName = oneVersionedFile(names, version, installerExt, "Tauri installer");
  const installer = files.find(({ name }) => name === installerName);
  const updateCandidates = files.filter(({ name }) =>
    /\.(app\.tar\.gz|nsis\.zip)$/.test(name) && versionPattern(version).test(name)
  );
  const updateBinary = updateCandidates[0] || installer;
  const signature = files.find(({ name }) => name === `${updateBinary.name}.sig`) || files.find(({ name }) => name === `${installer.name}.sig`);
  const metadata = files.find(({ name }) => name === "latest.json") || files.find(({ name }) => name === "latest-" + target.platform + ".json");
  if (!metadata) throw new Error("Missing Tauri updater latest.json metadata");
  if (!signature) throw new Error(`Missing Tauri updater signature for ${updateBinary.name}`);
  const metadataBody = fs.readFileSync(metadata.path, "utf8");
  if (!metadataBody.includes(updateBinary.name)) {
    throw new Error(`Tauri updater metadata does not reference ${updateBinary.name}`);
  }
  const selected = [installer, updateBinary, metadata, signature].filter(Boolean);
  for (const file of selected) assertFresh(file.path, buildStartedAt);
  return {
    installer: installer.path,
    liveUpdateFiles: selected.slice(1).map((file) => file.path)
  };
}

export function parseEnvFile(source) {
  const values = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsAt = line.indexOf("=");
    if (equalsAt <= 0) continue;
    const key = line.slice(0, equalsAt).trim();
    let value = line.slice(equalsAt + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function loadReleaseConfig(repoRoot, processEnv = process.env) {
  const envPath = path.join(repoRoot, ".env.release.local");
  const fileEnv = fs.existsSync(envPath) ? parseEnvFile(fs.readFileSync(envPath, "utf8")) : {};
  const value = (key) => String(processEnv[key] ?? fileEnv[key] ?? "").trim();
  const config = {
    apiBase: value("DARTSNUT_RELEASE_API_BASE").replace(/\/+$/, ""),
    account: value("DARTSNUT_RELEASE_ACCOUNT"),
    password: value("DARTSNUT_RELEASE_PASSWORD"),
    description: value("DARTSNUT_RELEASE_DESCRIPTION")
  };
  const missing = [
    ["DARTSNUT_RELEASE_API_BASE", config.apiBase],
    ["DARTSNUT_RELEASE_ACCOUNT", config.account],
    ["DARTSNUT_RELEASE_PASSWORD", config.password]
  ].filter(([, current]) => !current).map(([key]) => key);
  if (missing.length) {
    throw new Error(`Missing release configuration: ${missing.join(", ")}`);
  }
  try {
    const url = new URL(config.apiBase);
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error();
  } catch {
    throw new Error("DARTSNUT_RELEASE_API_BASE must be an absolute HTTP(S) URL");
  }
  return config;
}

async function responseJson(response, endpoint) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${endpoint} returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok || Number(payload.code) !== 1001) {
    const detail = payload.desc || payload.msg || `HTTP ${response.status}`;
    throw new Error(`${endpoint} failed: ${detail}`);
  }
  return payload;
}

export function createReleaseApi(config, fetchImpl = fetch) {
  let token = "";
  const request = async (endpoint, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (token) headers.set("token", token);
    const response = await fetchImpl(`${config.apiBase}${endpoint}`, { ...options, headers });
    return responseJson(response, endpoint);
  };
  const postJson = (endpoint, body) => request(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const upload = async (endpoint, filePath) => {
    const form = new FormData();
    form.append("file", await fs.openAsBlob(filePath), path.basename(filePath));
    return request(endpoint, { method: "POST", body: form });
  };

  return {
    async login() {
      const payload = await postJson("/platform/user/login", {
        account: config.account,
        password: config.password
      });
      token = String(payload.data?.token || "");
      if (!token) throw new Error("Login response did not include a token");
    },
    async uploadInstaller(filePath) {
      const payload = await upload("/platform/upload/upload-app-installer", filePath);
      if (!payload.data?.url || !payload.data?.md5) {
        throw new Error("Installer upload response is missing URL or MD5");
      }
      return payload.data;
    },
    async findRelease(apiPlatform, version) {
      const pageSize = 100;
      for (let page = 1; ; page += 1) {
        const query = new URLSearchParams({
          platform: apiPlatform,
          version,
          page: String(page),
          size: String(pageSize)
        });
        const payload = await request(`/platform/app-release/list?${query}`);
        const rows = Array.isArray(payload.data?.list) ? payload.data.list : [];
        const match = rows.find(
          (row) => row.platform === apiPlatform && String(row.version) === version
        );
        if (match) return match;
        const total = Number(payload.data?.total) || 0;
        if (page * pageSize >= total || rows.length === 0) return null;
      }
    },
    saveRelease(existing, data) {
      return postJson(existing ? "/platform/app-release/edit" : "/platform/app-release/add", {
        ...(existing ? { id: existing.id } : {}),
        ...data
      });
    },
    async uploadLiveUpdate(filePath) {
      return upload("/platform/upload/upload-agent-update-yml", filePath);
    }
  };
}

export async function publishBuiltArtifacts({ api, target, version, artifacts, description = "", onStage = () => {} }) {
  await api.login();
  onStage("authenticated");

  const installer = await api.uploadInstaller(artifacts.installer);
  onStage(`installer uploaded: ${path.basename(artifacts.installer)}`);

  const existing = await api.findRelease(target.apiPlatform, version);
  await api.saveRelease(existing, {
    platform: target.apiPlatform,
    version,
    download_url: installer.url,
    download_md5: installer.md5,
    is_current: true,
    status: true,
    description
  });
  onStage(existing ? "installer metadata updated" : "installer metadata created");

  for (const filePath of artifacts.liveUpdateFiles) {
    await api.uploadLiveUpdate(filePath);
    onStage(`live update uploaded: ${path.basename(filePath)}`);
  }
}
