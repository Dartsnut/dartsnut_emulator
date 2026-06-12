/**
 * The bundled python-build-standalone venv on Windows carries no stdlib of its
 * own; the interpreter resolves it via pyvenv.cfg's `home =` line. An inherited
 * PYTHONHOME/PYTHONPATH from the user's machine environment overrides that and
 * points the interpreter at a directory with no stdlib, so init dies with
 * "No module named 'encodings'". Declining to *set* PYTHONHOME is not enough —
 * any value already in the inherited environment must be stripped before we
 * hand the env to uv or the bundled interpreter.
 *
 * Off-Windows the venv stdlib is configured explicitly (PYTHONHOME is set to
 * the venv dir by callers), so the env is left untouched.
 *
 * This module intentionally has no imports so it can be unit-tested without
 * pulling in electron.
 */
export function stripInheritedPythonHome(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== "win32") {
    return env;
  }
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  return env;
}
