const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

test("generate_packaged_env emits decryption key but not legacy Xiaomi credentials", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "packaged-env-"));
  try {
    fs.mkdirSync(path.join(tempRoot, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(tempRoot, "apps", "desktop"), { recursive: true });
    fs.copyFileSync(
      path.join(repoRoot, "scripts", "generate_packaged_env.mjs"),
      path.join(tempRoot, "scripts", "generate_packaged_env.mjs")
    );
    fs.writeFileSync(
      path.join(tempRoot, ".env"),
      [
        "DARTSNUT_MODEL_DECRYPTION_KEY=decrypt-secret",
        "DARTSNUT_GOOGLE_DESKTOP_CLIENT_ID=desktop-client",
        "DARTSNUT_GOOGLE_DESKTOP_CLIENT_SECRET=desktop-secret",
        "XIAOMI_BASE_URL=https://legacy.example.com",
        "XIAOMI_API_KEY=legacy-key",
        "XIAOMI_MODEL=legacy-model"
      ].join("\n")
    );

    const result = spawnSync(process.execPath, ["scripts/generate_packaged_env.mjs"], {
      cwd: tempRoot,
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const generated = fs.readFileSync(path.join(tempRoot, "apps", "desktop", "packagedEnv.generated.ts"), "utf8");
    assert.match(generated, /DARTSNUT_MODEL_DECRYPTION_KEY/);
    assert.match(generated, /DARTSNUT_GOOGLE_DESKTOP_CLIENT_ID/);
    assert.match(generated, /DARTSNUT_GOOGLE_DESKTOP_CLIENT_SECRET/);
    assert.doesNotMatch(generated, /XIAOMI_BASE_URL|XIAOMI_API_KEY|XIAOMI_MODEL/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
