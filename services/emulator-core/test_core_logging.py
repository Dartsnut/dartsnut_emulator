"""Regression tests for emulator bridge lifecycle logging.

Run with:
    python -m unittest discover -s services/emulator-core -p 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent
CORE_PATH = ROOT / "core.py"


def _load_core_module():
    spec = importlib.util.spec_from_file_location("emulator_core", CORE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module spec from {CORE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_widget_conf(workspace: Path, widget_dir_name: str) -> None:
    widget_dir = workspace / widget_dir_name
    widget_dir.mkdir(parents=True, exist_ok=True)
    (widget_dir / "conf.json").write_text(
        json.dumps(
            {
                "id": "demo-widget",
                "name": "Demo Widget",
                "type": "game",
                "size": [128, 160],
            }
        ),
        encoding="utf-8",
    )


class LifecycleLoggingTests(unittest.TestCase):
    def test_reload_widget_logs_launch_attempt_and_failure(self):
        module = _load_core_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_widget_conf(workspace, "demo")
            with mock.patch.object(module.EmulatorCore, "_init_shared_memory", lambda self: None):
                core = module.EmulatorCore(workspace_root=str(workspace))
            self.addCleanup(core.shutdown)

            core.apply_command({"type": "set_path", "path": "demo"})

            with (
                mock.patch.object(module.time, "sleep", lambda _: None),
                mock.patch.object(module.subprocess, "Popen", side_effect=OSError("spawn broken")),
            ):
                state = core.apply_command({"type": "reload_widget"})

            logs = core.poll_widget_logs()
            texts = [entry["text"] for entry in logs]
            self.assertEqual(state["status"], "Command failed")
            self.assertEqual(state["lastError"], "spawn broken")
            self.assertTrue(any("reload_widget requested" in text for text in texts), texts)
            self.assertTrue(any("launch command" in text for text in texts), texts)
            self.assertTrue(any("spawn broken" in text for text in texts), texts)


class WidgetLaunchCommandTests(unittest.TestCase):
    def test_widget_launch_uses_uv_workspace_run_when_venv_ready(self):
        module = _load_core_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            demo_dir = workspace / "demo"
            _write_widget_conf(workspace, "demo")
            (demo_dir / "main.py").write_text("print('ok')\n", encoding="utf-8")
            venv_python = demo_dir / ".venv" / "bin" / "python"
            venv_python.parent.mkdir(parents=True, exist_ok=True)
            venv_python.write_text("", encoding="utf-8")
            with mock.patch.object(module.EmulatorCore, "_init_shared_memory", lambda self: None):
                core = module.EmulatorCore(workspace_root=str(workspace))
            self.addCleanup(core.shutdown)

            core.apply_command({"type": "set_path", "path": "demo"})
            uv_bin = "/tmp/dartsnut-uv-test"
            captured: dict[str, object] = {}

            def fake_isfile(path: str) -> bool:
                normalized = str(path)
                return normalized == uv_bin or normalized == str(venv_python)

            def fake_popen(command, **kwargs):
                captured["command"] = command
                captured["env"] = kwargs.get("env")
                raise OSError("spawn broken")

            with (
                mock.patch.object(module.time, "sleep", lambda _: None),
                mock.patch.object(module.os.path, "isfile", side_effect=fake_isfile),
                mock.patch.object(module.EmulatorCore, "_ensure_workspace_venv", return_value=True),
                mock.patch.dict(
                    module.os.environ,
                    {
                        "DARTSNUT_UV_BIN": uv_bin,
                        "UV_PYTHON": "/tmp/dartsnut-python-test",
                        "UV_NO_SYNC": "1",
                    },
                    clear=False,
                ),
                mock.patch.object(module.subprocess, "Popen", side_effect=fake_popen),
            ):
                core.apply_command({"type": "reload_widget"})

            command = captured.get("command", [])
            child_env = captured.get("env", {})
            self.assertNotIn("UV_NO_SYNC", child_env)
            self.assertNotIn("UV_NO_PROJECT", child_env)
            self.assertEqual(command[0], uv_bin)
            self.assertEqual(command[1:4], ["run", "--directory", str(demo_dir)])
            self.assertEqual(command[4], "main.py")


class ShutdownCommandTests(unittest.TestCase):
    def test_shutdown_stops_widget(self):
        module = _load_core_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_widget_conf(workspace, "demo")
            (workspace / "demo" / "main.py").write_text("print('ok')\n", encoding="utf-8")
            with mock.patch.object(module.EmulatorCore, "_init_shared_memory", lambda self: None):
                core = module.EmulatorCore(workspace_root=str(workspace))
            self.addCleanup(core.shutdown)

            core.apply_command({"type": "set_path", "path": "demo"})
            proc = mock.MagicMock()
            proc.poll.return_value = None
            proc.pid = 9999
            core.widget_process = proc
            core.state.running = True

            with mock.patch.object(module, "_kill_process_tree") as kill_tree:
                state = core.apply_command({"type": "shutdown"})

            kill_tree.assert_called()
            self.assertIsNone(core.widget_process)
            self.assertFalse(state["running"])
            self.assertEqual(state["status"], "Shutting down")


class WidgetLaunchEnvTests(unittest.TestCase):
    def test_widget_launch_uses_dummy_video_but_not_dummy_audio(self):
        module = _load_core_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_widget_conf(workspace, "demo")
            (workspace / "demo" / "main.py").write_text("print('ok')\n", encoding="utf-8")
            with mock.patch.object(module.EmulatorCore, "_init_shared_memory", lambda self: None):
                core = module.EmulatorCore(workspace_root=str(workspace))
            self.addCleanup(core.shutdown)

            core.apply_command({"type": "set_path", "path": "demo"})
            captured: dict[str, object] = {}

            def _capture_popen(*args, **kwargs):
                captured["env"] = kwargs.get("env")
                proc = mock.MagicMock()
                proc.poll.return_value = 0
                proc.stdout = None
                proc.stderr = None
                proc.pid = 4242
                return proc

            with (
                mock.patch.object(module.time, "sleep", lambda _: None),
                mock.patch.object(module.subprocess, "Popen", side_effect=_capture_popen),
            ):
                core.start_widget_process_for_current()

            env = captured.get("env")
            self.assertIsInstance(env, dict)
            assert isinstance(env, dict)
            self.assertEqual(env.get("SDL_VIDEODRIVER"), "dummy")
            self.assertNotIn("SDL_AUDIODRIVER", env)


if __name__ == "__main__":
    unittest.main()
