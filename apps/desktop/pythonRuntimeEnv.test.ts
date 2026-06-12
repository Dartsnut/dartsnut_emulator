const assert = require("node:assert/strict");
const test = require("node:test");

const { stripInheritedPythonHome } = require("./pythonEnvSanitize.ts");

// Regression: an inherited PYTHONHOME/PYTHONPATH from the user's machine must
// never leak into the env we hand the bundled python-build-standalone runtime
// on Windows — it overrides pyvenv.cfg stdlib resolution and kills interpreter
// init with "No module named 'encodings'". See pythonEnvSanitize.ts.

test("stripInheritedPythonHome removes inherited PYTHONHOME/PYTHONPATH on Windows", () => {
  const env = {
    PATH: "C:\\Windows",
    PYTHONHOME: "C:\\Users\\u\\AppData\\Roaming\\dartsnut-agent\\runtime\\python-3.12.7",
    PYTHONPATH: "C:\\some\\rogue\\path",
  };
  const result = stripInheritedPythonHome(env);
  if (process.platform === "win32") {
    assert.equal(result.PYTHONHOME, undefined, "PYTHONHOME must be stripped on Windows");
    assert.equal(result.PYTHONPATH, undefined, "PYTHONPATH must be stripped on Windows");
    assert.equal(result.PATH, "C:\\Windows", "unrelated vars must be preserved");
  } else {
    // Off-Windows the helper is a passthrough; callers set PYTHONHOME explicitly.
    assert.equal(result.PYTHONHOME, env.PYTHONHOME, "PYTHONHOME untouched off-Windows");
  }
});

test("stripInheritedPythonHome leaves an env without those vars intact", () => {
  const env = { PATH: process.platform === "win32" ? "C:\\Windows" : "/usr/bin" };
  const result = stripInheritedPythonHome(env);
  assert.equal(result.PYTHONHOME, undefined);
  assert.equal(result.PYTHONPATH, undefined);
});
