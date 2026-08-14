"""Per-workspace virtualenv setup for emulator preview (mirrors dartsnut_rpi app_env)."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import tomllib
from collections.abc import Callable
from typing import Any

PYPI_MIRRORS = [
    "https://pypi.org/simple",
    "https://mirrors.ustc.edu.cn/pypi/simple",
]
RETRIES_PER_MIRROR = 3
LogFn = Callable[[str, str], None]
StatusFn = Callable[[str], None]


def _uv_bin() -> str:
    return os.environ.get("DARTSNUT_UV_BIN", "").strip()


def _bundled_python() -> str:
    return os.environ.get("UV_PYTHON", "").strip() or sys.executable


def _pyproject_path(workspace_dir: str) -> str:
    return os.path.join(workspace_dir, "pyproject.toml")


def _normalized_distribution_name(requirement: str) -> str | None:
    match = re.match(r"\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)", requirement)
    return re.sub(r"[._-]+", "", match.group(1).lower()) if match else None


def classify_workspace_project(workspace_dir: str) -> tuple[str, dict[str, Any], str, str]:
    """Return (project_type, widget_config, app_id, version) for a valid Dartsnut project."""
    pyproject_path = _pyproject_path(workspace_dir)
    if not os.path.exists(pyproject_path):
        raise ValueError("pyproject.toml was not found")
    try:
        with open(pyproject_path, "rb") as f:
            pyproject = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise ValueError(f"Could not parse pyproject.toml: {e}") from e

    project = pyproject.get("project")
    if not isinstance(project, dict):
        raise ValueError("pyproject.toml must contain a [project] table")
    app_id = str(project.get("name") or "").strip()
    if not app_id:
        raise ValueError("pyproject.toml [project].name must not be empty")
    version = str(project.get("version") or "").strip()
    if not version:
        raise ValueError("pyproject.toml [project].version must not be empty")
    dependencies = project.get("dependencies")
    if not isinstance(dependencies, list) or not all(isinstance(item, str) for item in dependencies):
        raise ValueError("pyproject.toml [project].dependencies must be an array of strings")
    if not any(_normalized_distribution_name(item) == "pydartsnut" for item in dependencies):
        raise ValueError("pyproject.toml must declare pydartsnut in [project].dependencies")

    conf_path = os.path.join(workspace_dir, "conf.json")
    if not os.path.exists(conf_path):
        return "game", {}, app_id, version
    try:
        with open(conf_path, encoding="utf-8") as f:
            conf = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise ValueError(f"Broken widget conf.json: {e}") from e
    if not isinstance(conf, dict) or "size" not in conf or "fields" not in conf:
        raise ValueError("Broken widget conf.json: size and fields are required")
    return "widget", conf, app_id, version


_WORKSPACE_ENV_REMOVE = (
    "VIRTUAL_ENV",
    "PYTHONHOME",
    "PYTHONPATH",
    "PYTHONUSERBASE",
    "UV_NO_PROJECT",
    "UV_NO_SYNC",
    "UV_PROJECT_ENVIRONMENT",
)


def _clean_workspace_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base_env is None else base_env)
    for key in _WORKSPACE_ENV_REMOVE:
        env.pop(key, None)
    env["PYTHONNOUSERSITE"] = "1"
    return env


def _python_home_for(python_exe: str) -> str | None:
    if sys.platform == "win32":
        return None
    bin_dir = os.path.dirname(os.path.abspath(python_exe))
    if os.path.basename(bin_dir) != "bin":
        return None
    return os.path.dirname(bin_dir)


def _uv_env() -> dict[str, str]:
    env = _clean_workspace_env()
    env["UV_NO_PYTHON_DOWNLOADS"] = "never"
    env["UV_NO_MANAGED_PYTHON"] = "1"
    python_exe = _bundled_python()
    if python_exe:
        env["UV_PYTHON"] = python_exe
        python_home = _python_home_for(python_exe)
        if python_home:
            env["PYTHONHOME"] = python_home

    # Use preferred PyPI index URL if available (set by TypeScript side)
    pypi_index = os.environ.get("DARTSNUT_PYPI_INDEX_URL", "").strip()
    if pypi_index:
        env["UV_INDEX_URL"] = pypi_index

    return env


def _uv_sync(workspace_dir: str) -> None:
    """Run uv sync with automatic mirror fallback on PyPI failures."""
    uv = _uv_bin()
    if not uv:
        raise RuntimeError("DARTSNUT_UV_BIN is not configured")

    env = _uv_env()
    preferred_mirror = env.get("UV_INDEX_URL", "").strip()

    # Try preferred mirror first if we have one, otherwise try all mirrors
    mirrors_to_try = []
    if preferred_mirror and preferred_mirror in PYPI_MIRRORS:
        mirrors_to_try.append(preferred_mirror)
        mirrors_to_try.extend([m for m in PYPI_MIRRORS if m != preferred_mirror])
    else:
        mirrors_to_try = PYPI_MIRRORS[:]

    last_error = None

    for mirror in mirrors_to_try:
        for attempt in range(1, RETRIES_PER_MIRROR + 1):
            try:
                mirror_env = dict(env)
                mirror_env["UV_INDEX_URL"] = mirror

                # uv sync is exact by default; bundled uv 0.11.19 exposes only the --inexact opt-out.
                subprocess.run(
                    [uv, "sync", "--directory", workspace_dir],
                    check=True,
                    capture_output=True,
                    text=True,
                    env=mirror_env,
                )
                return  # Success!

            except subprocess.CalledProcessError as e:
                last_error = e
                stderr = (e.stderr or "").strip()

                # Wait before retry (exponential backoff: 1s, 2s, 4s)
                if attempt < RETRIES_PER_MIRROR:
                    time.sleep(2 ** (attempt - 1))

    # All mirrors exhausted
    if last_error:
        stderr = (last_error.stderr or "").strip()
        raise RuntimeError(
            f"Failed to sync dependencies after trying all PyPI mirrors.\n"
            f"Mirrors attempted: {', '.join(mirrors_to_try)}\n"
            f"Last error: {stderr or str(last_error)}"
        )
    else:
        raise RuntimeError("uv sync failed with unknown error")


def ensure_workspace_venv(
    workspace_dir: str,
    *,
    app_type: str | None = None,
    log: LogFn | None = None,
    status: StatusFn | None = None,
) -> bool:
    """Create or refresh <workspace>/.venv using bundled uv. Returns False on failure."""
    uv = _uv_bin()
    if not uv or not os.path.isfile(uv):
        return True

    main_py = os.path.join(workspace_dir, "main.py")
    if not os.path.isfile(main_py):
        if log:
            log(f"Workspace venv skipped: missing main.py in {workspace_dir}", "stderr")
        return False

    started = time.monotonic()
    try:
        resolved_type, _, _, _ = classify_workspace_project(workspace_dir)
        if status:
            status("Preparing workspace environment…")
        if log:
            log("Syncing workspace dependencies from pyproject.toml", "stdout")
        if status:
            status("Syncing dependencies…")
        _uv_sync(workspace_dir)
        if log:
            log(
                f"Workspace .venv ready (type={resolved_type}, elapsed={time.monotonic() - started:.1f}s)",
                "stdout",
            )
        return True
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        if log:
            log(
                f"uv sync failed: {e}{f' stderr={stderr}' if stderr else ''}",
                "stderr",
            )
        return False
    except Exception as e:
        if log:
            log(f"Workspace venv setup failed: {e}", "stderr")
        return False


def workspace_launch_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    env = _clean_workspace_env(base_env)
    env.setdefault("PYTHONUNBUFFERED", "1")
    env["UV_NO_PYTHON_DOWNLOADS"] = "never"
    env["UV_NO_MANAGED_PYTHON"] = "1"
    python_exe = _bundled_python()
    if python_exe:
        env["UV_PYTHON"] = python_exe
    return env
