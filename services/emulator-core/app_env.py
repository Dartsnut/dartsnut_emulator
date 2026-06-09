"""Per-workspace virtualenv setup for emulator preview (mirrors dartsnut_rpi app_env)."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

DEFAULTS_DIR = Path(__file__).resolve().parent / "app_defaults"
STAMP_FILENAME = ".dartsnut_stamp"
MANAGED_PYPROJECT_HEADER = "# Dartsnut managed default app dependencies"
LogFn = Callable[[str, str], None]
StatusFn = Callable[[str], None]


def _uv_bin() -> str:
    return os.environ.get("DARTSNUT_UV_BIN", "").strip()


def _bundled_python() -> str:
    return os.environ.get("UV_PYTHON", "").strip() or sys.executable


def _venv_python(workspace_dir: str) -> str:
    if sys.platform == "win32":
        return os.path.join(workspace_dir, ".venv", "Scripts", "python.exe")
    return os.path.join(workspace_dir, ".venv", "bin", "python")


def _pyproject_path(workspace_dir: str) -> str:
    return os.path.join(workspace_dir, "pyproject.toml")


def _stamp_path(workspace_dir: str) -> str:
    return os.path.join(workspace_dir, ".venv", STAMP_FILENAME)


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


def _read_conf_version(workspace_dir: str) -> str:
    return str(_read_conf(workspace_dir).get("version") or "")


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


def _materialize_pyproject(workspace_dir: str, app_type: str, log: LogFn | None = None) -> None:
    dest = _pyproject_path(workspace_dir)
    template = _template_path(app_type)
    template_text = template.read_text(encoding="utf-8")
    if os.path.isfile(dest):
        if not _is_managed_default_pyproject(dest):
            if log:
                log(f"Using existing pyproject.toml in {workspace_dir}", "stdout")
            return
        with open(dest, encoding="utf-8") as f:
            if f.read() == template_text:
                return
        shutil.copy2(template, dest)
        if log:
            log(f"Refreshed default pyproject.toml (type={app_type})", "stdout")
        return
    shutil.copy2(template, dest)
    if log:
        log(f"Materialized default pyproject.toml (type={app_type})", "stdout")


def _stamp_payload(workspace_dir: str, app_type: str) -> str:
    pyproject = _pyproject_path(workspace_dir)
    content = ""
    if os.path.isfile(pyproject):
        with open(pyproject, encoding="utf-8") as f:
            content = f.read()
    template_fp = _template_path(app_type).read_text(encoding="utf-8")
    version = _read_conf_version(workspace_dir)
    return f"{content}\n---\n{template_fp}\n---\n{version}"


def _compute_stamp(workspace_dir: str, app_type: str) -> str:
    return hashlib.sha256(_stamp_payload(workspace_dir, app_type).encode("utf-8")).hexdigest()


def workspace_venv_ready(workspace_dir: str, app_type: str) -> bool:
    python_path = _venv_python(workspace_dir)
    stamp_path = _stamp_path(workspace_dir)
    if not os.path.isfile(python_path) or not os.path.isfile(stamp_path):
        return False
    try:
        with open(stamp_path, encoding="utf-8") as f:
            stored = f.read().strip()
        return stored == _compute_stamp(workspace_dir, app_type)
    except OSError:
        return False


def _uv_env() -> dict[str, str]:
    env = dict(os.environ)
    env.pop("UV_NO_SYNC", None)
    env.pop("UV_NO_PROJECT", None)
    env["UV_NO_PYTHON_DOWNLOADS"] = "never"
    env["UV_NO_MANAGED_PYTHON"] = "1"
    python_exe = _bundled_python()
    if python_exe:
        env["UV_PYTHON"] = python_exe
    return env


def _uv_sync(workspace_dir: str) -> None:
    uv = _uv_bin()
    if not uv:
        raise RuntimeError("DARTSNUT_UV_BIN is not configured")
    subprocess.run(
        [uv, "sync", "--directory", workspace_dir],
        check=True,
        capture_output=True,
        text=True,
        env=_uv_env(),
    )


def _write_stamp(workspace_dir: str, app_type: str) -> None:
    stamp_path = _stamp_path(workspace_dir)
    os.makedirs(os.path.dirname(stamp_path), exist_ok=True)
    with open(stamp_path, "w", encoding="utf-8") as f:
        f.write(_compute_stamp(workspace_dir, app_type))


def ensure_workspace_venv(
    workspace_dir: str,
    *,
    app_type: str | None = None,
    force: bool = False,
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
    if not force and workspace_venv_ready(workspace_dir, resolved_type):
        if log:
            log("Workspace .venv is up to date", "stdout")
        return True

    started = time.monotonic()
    try:
        if status:
            status("Preparing workspace environment…")
        if not os.path.isfile(_pyproject_path(workspace_dir)):
            if status:
                status("Setting up pyproject.toml…")
            _materialize_pyproject(workspace_dir, resolved_type, log=log)
        elif log:
            log("Syncing workspace dependencies from pyproject.toml", "stdout")
        if status:
            status("Syncing dependencies…")
        _uv_sync(workspace_dir)
        _write_stamp(workspace_dir, resolved_type)
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
    env = dict(base_env or os.environ)
    env.pop("UV_NO_SYNC", None)
    env.pop("UV_NO_PROJECT", None)
    env.setdefault("PYTHONUNBUFFERED", "1")
    env["UV_NO_PYTHON_DOWNLOADS"] = "never"
    env["UV_NO_MANAGED_PYTHON"] = "1"
    python_exe = _bundled_python()
    if python_exe:
        env["UV_PYTHON"] = python_exe
    return env
