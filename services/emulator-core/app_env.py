"""Per-workspace virtualenv setup for emulator preview (mirrors dartsnut_rpi app_env)."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

DEFAULTS_DIR = Path(__file__).resolve().parent / "app_defaults"
MANAGED_PYPROJECT_HEADER = "# Dartsnut managed default app dependencies"
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


def _read_conf(workspace_dir: str) -> dict[str, Any]:
    conf_path = os.path.join(workspace_dir, "conf.json")
    try:
        with open(conf_path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError) as e:
        _log.warning("Failed to read conf.json in %s: %s", workspace_dir, e)
        return {}


def _read_conf_type(workspace_dir: str) -> str:
    app_type = _read_conf(workspace_dir).get("type")
    return str(app_type) if app_type else "widget"


def _template_path(app_type: str) -> Path:
    kind = app_type if app_type in ("game", "widget") else "widget"
    path = DEFAULTS_DIR / f"{kind}_pyproject.toml"
    if not path.is_file():
        raise FileNotFoundError(f"Missing default template: {path}")
    return path


def _is_managed_default_pyproject(path: str) -> bool:
    try:
        with open(path, encoding="utf-8") as f:
            return f.readline().startswith(MANAGED_PYPROJECT_HEADER)
    except OSError:
        return False


def _sync_pyproject_project_metadata(text: str, app_id: str, version: str) -> str:
    """Apply canonical conf.json identity to only the [project] TOML section."""
    project_match = re.search(r"(?m)^\s*\[project\]\s*(?:#.*)?$", text)
    if not project_match:
        separator = "" if not text or text.endswith("\n") else "\n"
        return (
            f"{text}{separator}\n[project]\n"
            f"name = {json.dumps(app_id)}\nversion = {json.dumps(version)}\n"
        )

    section_start = project_match.end()
    next_section = re.search(r"(?m)^\s*\[[^]\n]+\]\s*(?:#.*)?$", text[section_start:])
    section_end = section_start + next_section.start() if next_section else len(text)
    section = text[section_start:section_end]
    missing: list[str] = []
    for key, value in (("name", app_id), ("version", version)):
        assignment = re.compile(rf"(?m)^(\s*){re.escape(key)}\s*=.*$")
        if assignment.search(section):
            section = assignment.sub(
                lambda match, current_key=key, current_value=value: (
                    f"{match.group(1)}{current_key} = {json.dumps(current_value)}"
                ),
                section,
                count=1,
            )
        else:
            missing.append(f"{key} = {json.dumps(value)}")
    if missing:
        leading_break = "\n" if section.startswith("\n") else ""
        inserted = "\n".join(missing)
        section = f"{leading_break}\n{inserted}\n{section[len(leading_break):]}"
    return text[:section_start] + section + text[section_end:]


def _materialize_pyproject(workspace_dir: str, app_type: str, log: LogFn | None = None) -> None:
    dest = _pyproject_path(workspace_dir)
    template = _template_path(app_type)
    conf = _read_conf(workspace_dir)
    app_id = str(conf.get("id") or "").strip()
    version = str(conf.get("version") or "").strip()
    if not app_id or not version:
        raise ValueError("conf.json must contain non-empty id and version fields")

    if Path(dest).is_file() and not _is_managed_default_pyproject(dest):
        current_text = Path(dest).read_text(encoding="utf-8")
        synced_text = _sync_pyproject_project_metadata(current_text, app_id, version)
        if synced_text != current_text:
            Path(dest).write_text(synced_text, encoding="utf-8")
            if log:
                log("Synchronized pyproject.toml name and version from conf.json", "stdout")
        elif log:
            log(f"Using existing pyproject.toml in {workspace_dir}", "stdout")
        return

    template_text = _sync_pyproject_project_metadata(
        template.read_text(encoding="utf-8"), app_id, version
    )
    if Path(dest).is_file():
        if Path(dest).read_text(encoding="utf-8") == template_text:
            return
        Path(dest).write_text(template_text, encoding="utf-8")
        if log:
            log(f"Refreshed default pyproject.toml (type={app_type})", "stdout")
        return
    Path(dest).write_text(template_text, encoding="utf-8")
    if log:
        log(f"Materialized default pyproject.toml (type={app_type})", "stdout")


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

    resolved_type = app_type or _read_conf_type(workspace_dir)
    started = time.monotonic()
    try:
        if status:
            status("Preparing workspace environment…")
        had_pyproject = os.path.isfile(_pyproject_path(workspace_dir))
        if not had_pyproject and status:
            status("Setting up pyproject.toml…")
        _materialize_pyproject(workspace_dir, resolved_type, log=log)
        if had_pyproject and log:
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
