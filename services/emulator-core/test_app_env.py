"""Tests for workspace venv helpers (app_env.py)."""

from __future__ import annotations

import importlib.util
import json
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


class AppEnvTests(unittest.TestCase):
    def test_materializes_game_pyproject_when_missing(self):
        module = _load_app_env_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            (workspace / "main.py").write_text("print('ok')\n", encoding="utf-8")
            (workspace / "conf.json").write_text(
                json.dumps({"id": "demo", "type": "game", "version": "1"}),
                encoding="utf-8",
            )
            module._materialize_pyproject(str(workspace), "game")
            pyproject = workspace / "pyproject.toml"
            self.assertTrue(pyproject.is_file())
            text = pyproject.read_text(encoding="utf-8")
            self.assertTrue(text.startswith(module.MANAGED_PYPROJECT_HEADER))
            self.assertIn("pygame-ce==2.5.7", text)

    def test_materializes_widget_template_for_widget_type(self):
        module = _load_app_env_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            (workspace / "main.py").write_text("print('ok')\n", encoding="utf-8")
            (workspace / "conf.json").write_text(
                json.dumps({"id": "demo", "type": "widget", "version": "1"}),
                encoding="utf-8",
            )
            module._materialize_pyproject(str(workspace), "widget")
            text = (workspace / "pyproject.toml").read_text(encoding="utf-8")
            self.assertIn("aiohttp==3.13.3", text)
            self.assertNotIn("evdev==", text)

    def test_ensure_workspace_venv_runs_uv_sync_when_stamp_stale(self):
        module = _load_app_env_module()
        logs: list[tuple[str, str]] = []

        def log(text: str, source: str = "stdout") -> None:
            logs.append((source, text))

        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            (workspace / "main.py").write_text("print('ok')\n", encoding="utf-8")
            (workspace / "conf.json").write_text(
                json.dumps({"id": "demo", "type": "game", "version": "1"}),
                encoding="utf-8",
            )
            module._materialize_pyproject(str(workspace), "game")

            with (
                mock.patch.dict(
                    module.os.environ,
                    {"DARTSNUT_UV_BIN": "/tmp/uv", "UV_PYTHON": "/tmp/python"},
                    clear=False,
                ),
                mock.patch.object(module.os.path, "isfile", return_value=True),
                mock.patch.object(module, "_uv_sync") as uv_sync,
                mock.patch.object(module, "_write_stamp") as write_stamp,
            ):
                ok = module.ensure_workspace_venv(str(workspace), app_type="game", log=log)

            self.assertTrue(ok)
            uv_sync.assert_called_once_with(str(workspace))
            write_stamp.assert_called_once()
            self.assertTrue(any("ready" in text for _source, text in logs))


if __name__ == "__main__":
    unittest.main()
