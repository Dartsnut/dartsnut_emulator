"""Tests for workspace venv helpers (app_env.py)."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent
APP_ENV_PATH = ROOT / "app_env.py"


def _load_app_env_module():
    spec = importlib.util.spec_from_file_location("emulator_app_env", APP_ENV_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module spec from {APP_ENV_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_workspace(workspace: Path, app_type: str = "game") -> None:
    (workspace / "main.py").write_text("print('ok')\n", encoding="utf-8")
    (workspace / "pyproject.toml").write_text(
        "[project]\nname = 'demo'\nversion = '1'\ndependencies = ['pydartsnut==1.2.1']\n",
        encoding="utf-8",
    )
    if app_type == "widget":
        (workspace / "conf.json").write_text(
            json.dumps({"size": [128, 128], "fields": []}),
            encoding="utf-8",
        )


class AppEnvTests(unittest.TestCase):
    def test_classifies_game_without_conf(self):
        module = _load_app_env_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_workspace(workspace, "game")
            self.assertEqual(module.classify_workspace_project(str(workspace)), ("game", {}, "demo", "1"))

    def test_classifies_widget_from_required_conf_keys(self):
        module = _load_app_env_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_workspace(workspace, "widget")
            app_type, conf, app_id, version = module.classify_workspace_project(str(workspace))
            self.assertEqual((app_type, app_id, version), ("widget", "demo", "1"))
            self.assertEqual(conf["fields"], [])

    def test_rejects_broken_widget(self):
        module = _load_app_env_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_workspace(workspace, "game")
            (workspace / "conf.json").write_text('{"size":[128,128]}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Broken widget"):
                module.classify_workspace_project(str(workspace))

    def test_existing_stamp_does_not_skip_workspace_sync(self):
        module = _load_app_env_module()
        logs: list[tuple[str, str]] = []

        def log(text: str, source: str = "stdout") -> None:
            logs.append((source, text))

        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_workspace(workspace, "game")
            stamp = workspace / ".venv" / ".dartsnut_stamp"
            stamp.parent.mkdir(parents=True)
            stamp.write_text("previously-ready", encoding="utf-8")

            with (
                mock.patch.dict(
                    module.os.environ,
                    {"DARTSNUT_UV_BIN": "/tmp/uv", "UV_PYTHON": "/runtime/bin/python"},
                    clear=False,
                ),
                mock.patch.object(module.os.path, "isfile", return_value=True),
                mock.patch.object(module, "_uv_sync") as uv_sync,
            ):
                ok = module.ensure_workspace_venv(str(workspace), app_type="game", log=log)

            self.assertTrue(ok)
            uv_sync.assert_called_once_with(str(workspace))
            self.assertEqual(stamp.read_text(encoding="utf-8"), "previously-ready")
            self.assertTrue(any("ready" in text for _source, text in logs))

    def test_uv_sync_uses_default_exact_mode_and_clean_controlled_environment(self):
        module = _load_app_env_module()
        inherited = {
            "DARTSNUT_UV_BIN": "/tmp/uv",
            "DARTSNUT_PYPI_INDEX_URL": "https://pypi.org/simple",
            "UV_PYTHON": "/runtime/bin/python",
            "VIRTUAL_ENV": "/host/venv",
            "PYTHONHOME": "/host/python",
            "PYTHONPATH": "/host/packages",
            "PYTHONUSERBASE": "/host/userbase",
            "UV_NO_PROJECT": "1",
            "UV_NO_SYNC": "1",
            "UV_PROJECT_ENVIRONMENT": "/other/venv",
            "KEEP_ME": "yes",
        }

        with (
            mock.patch.dict(module.os.environ, inherited, clear=True),
            mock.patch.object(module.subprocess, "run") as run,
        ):
            module._uv_sync("/workspace/demo")

        command = run.call_args.args[0]
        env = run.call_args.kwargs["env"]
        self.assertEqual(command, ["/tmp/uv", "sync", "--directory", "/workspace/demo"])
        self.assertNotIn("--inexact", command)
        for key in (
            "VIRTUAL_ENV",
            "PYTHONPATH",
            "PYTHONUSERBASE",
            "UV_NO_PROJECT",
            "UV_NO_SYNC",
            "UV_PROJECT_ENVIRONMENT",
        ):
            self.assertNotIn(key, env)
        self.assertEqual(env["PYTHONNOUSERSITE"], "1")
        self.assertEqual(env["UV_PYTHON"], "/runtime/bin/python")
        self.assertEqual(env["KEEP_ME"], "yes")
        if module.sys.platform == "win32":
            self.assertNotIn("PYTHONHOME", env)
        else:
            self.assertEqual(env["PYTHONHOME"], "/runtime")

    def test_workspace_launch_env_removes_python_and_uv_overrides(self):
        module = _load_app_env_module()
        base_env = {
            "PATH": "/usr/bin",
            "VIRTUAL_ENV": "/host/venv",
            "PYTHONHOME": "/host/python",
            "PYTHONPATH": "/host/packages",
            "PYTHONUSERBASE": "/host/userbase",
            "UV_NO_PROJECT": "1",
            "UV_NO_SYNC": "1",
            "UV_PROJECT_ENVIRONMENT": "/other/venv",
            "KEEP_ME": "yes",
        }

        with mock.patch.dict(module.os.environ, {"UV_PYTHON": "/runtime/bin/python"}, clear=True):
            env = module.workspace_launch_env(base_env)

        for key in module._WORKSPACE_ENV_REMOVE:
            self.assertNotIn(key, env)
        self.assertEqual(env["PYTHONNOUSERSITE"], "1")
        self.assertEqual(env["UV_PYTHON"], "/runtime/bin/python")
        self.assertEqual(env["PATH"], "/usr/bin")
        self.assertEqual(env["KEEP_ME"], "yes")

    def test_sync_failure_preserves_uv_error_and_does_not_write_success_state(self):
        module = _load_app_env_module()
        logs: list[tuple[str, str]] = []

        def log(text: str, source: str = "stdout") -> None:
            logs.append((source, text))

        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_workspace(workspace, "game")
            raw_error = "No solution found when resolving dependencies: missing-package"

            with (
                mock.patch.dict(module.os.environ, {"DARTSNUT_UV_BIN": "/tmp/uv"}, clear=False),
                mock.patch.object(module.os.path, "isfile", return_value=True),
                mock.patch.object(module, "_uv_sync", side_effect=RuntimeError(raw_error)),
            ):
                ok = module.ensure_workspace_venv(str(workspace), app_type="game", log=log)

            self.assertFalse(ok)
            self.assertFalse((workspace / ".venv" / ".dartsnut_stamp").exists())
            self.assertTrue(any(source == "stderr" and raw_error in text for source, text in logs), logs)

    def test_uv_sync_preserves_last_raw_stderr_after_mirror_failures(self):
        module = _load_app_env_module()
        failure = subprocess.CalledProcessError(
            1,
            ["uv", "sync"],
            stderr="invalid pyproject.toml dependency declaration",
        )

        with (
            mock.patch.dict(module.os.environ, {"DARTSNUT_UV_BIN": "/tmp/uv"}, clear=True),
            mock.patch.object(module.subprocess, "run", side_effect=failure),
            mock.patch.object(module.time, "sleep"),
        ):
            with self.assertRaisesRegex(RuntimeError, "invalid pyproject.toml dependency declaration"):
                module._uv_sync("/workspace/demo")


if __name__ == "__main__":
    unittest.main()
