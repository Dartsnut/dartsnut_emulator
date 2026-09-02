"""Regression tests for emulator bridge lifecycle logging.

Run with:
    python -m unittest discover -s services/emulator-core -p 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent
CORE_PATH = ROOT / "core.py"


class FakeSharedMemory:
    def __init__(self, size: int):
        self.buf = bytearray(size)

    def close(self):
        pass

    def unlink(self):
        pass


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
    (widget_dir / "pyproject.toml").write_text(
        "[project]\nname = 'demo-widget'\nversion = '1'\ndependencies = ['pydartsnut']\n",
        encoding="utf-8",
    )
    (widget_dir / "conf.json").write_text(
        json.dumps(
            {
                "name": "Demo Widget",
                "size": [128, 160],
                "fields": [],
            }
        ),
        encoding="utf-8",
    )


def _write_game_project(workspace: Path, game_dir_name: str) -> None:
    game_dir = workspace / game_dir_name
    game_dir.mkdir(parents=True, exist_ok=True)
    (game_dir / "pyproject.toml").write_text(
        "[project]\nname = 'demo-game'\nversion = '1'\ndependencies = ['pydartsnut']\n",
        encoding="utf-8",
    )


@contextmanager
def _managed_runtime(module):
    with (
        mock.patch.dict(
            module.os.environ,
            {
                "DARTSNUT_UV_BIN": "/tmp/dartsnut-uv-test",
                "UV_PYTHON": "/tmp/dartsnut-python-test",
            },
            clear=False,
        ),
        mock.patch.object(module.os.path, "isfile", return_value=True),
    ):
        yield


class LifecycleLoggingTests(unittest.TestCase):
    def test_load_game_without_conf_uses_pyproject_identity(self):
        module = _load_core_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_game_project(workspace, "demo")
            with mock.patch.object(module.EmulatorCore, "_init_shared_memory", lambda self: None):
                core = module.EmulatorCore(workspace_root=str(workspace))
            self.addCleanup(core.shutdown)

            state = core.apply_command({"type": "set_path", "path": "demo"})

            self.assertEqual(state["widgetType"], "game")
            self.assertEqual(state["widgetId"], "demo-game")

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
                _managed_runtime(module),
                mock.patch.object(module.time, "sleep", lambda _: None),
                mock.patch.object(module.EmulatorCore, "_ensure_workspace_venv", return_value=True),
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

    def test_failed_workspace_prep_aborts_before_process_launch(self):
        module = _load_core_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_widget_conf(workspace, "demo")
            (workspace / "demo" / "main.py").write_text("print('ok')\n", encoding="utf-8")
            with mock.patch.object(module.EmulatorCore, "_init_shared_memory", lambda self: None):
                core = module.EmulatorCore(workspace_root=str(workspace))
            self.addCleanup(core.shutdown)
            core.apply_command({"type": "set_path", "path": "demo"})

            with (
                mock.patch.object(module.time, "sleep", lambda _: None),
                mock.patch.object(module.EmulatorCore, "_ensure_workspace_venv", return_value=False),
                mock.patch.object(module.subprocess, "Popen") as popen,
            ):
                state = core.apply_command({"type": "reload_widget"})

            popen.assert_not_called()
            self.assertEqual(state["status"], "Command failed")
            self.assertIn("Failed to prepare workspace Python environment", state["lastError"])

    def test_reload_widget_invalidates_stale_shared_memory_frame_before_launch(self):
        module = _load_core_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_widget_conf(workspace, "demo")
            (workspace / "demo" / "main.py").write_text("print('ok')\n", encoding="utf-8")
            with mock.patch.object(module.EmulatorCore, "_init_shared_memory", lambda self: None):
                core = module.EmulatorCore(workspace_root=str(workspace))
            self.addCleanup(core.shutdown)
            core.shm_pdi = FakeSharedMemory(128 * 160 * 3 + 1)

            core.apply_command({"type": "set_path", "path": "demo"})
            stale_frame = bytes([99, 88, 77] * (128 * 160))
            core.shm_pdi.buf[1 : 1 + len(stale_frame)] = stale_frame
            core.shm_pdi.buf[0] = 0
            core._last_frame_bytes = stale_frame
            core._last_frame_w = 128
            core._last_frame_h = 160

            with (
                _managed_runtime(module),
                mock.patch.object(module.time, "sleep", lambda _: None),
                mock.patch.object(module.EmulatorCore, "_ensure_workspace_venv", return_value=True),
                mock.patch.object(module.subprocess, "Popen", side_effect=OSError("spawn broken")),
            ):
                core.apply_command({"type": "reload_widget"})

            self.assertEqual(core.shm_pdi.buf[0], 1)
            self.assertIsNone(core._last_frame_bytes)
            self.assertIsNone(core.read_latest_frame())


class WidgetLaunchCommandTests(unittest.TestCase):
    def test_widget_launch_rejects_missing_managed_uv_before_spawn(self):
        module = _load_core_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            demo_dir = workspace / "demo"
            _write_widget_conf(workspace, "demo")
            (demo_dir / "main.py").write_text("print('ok')\n", encoding="utf-8")
            with mock.patch.object(module.EmulatorCore, "_init_shared_memory", lambda self: None):
                core = module.EmulatorCore(workspace_root=str(workspace))
            self.addCleanup(core.shutdown)
            core.apply_command({"type": "set_path", "path": "demo"})

            with (
                mock.patch.object(module.EmulatorCore, "_ensure_workspace_venv", return_value=True),
                mock.patch.dict(module.os.environ, {}, clear=True),
                mock.patch.object(module.subprocess, "Popen") as popen,
            ):
                state = core.apply_command({"type": "reload_widget"})

            popen.assert_not_called()
            self.assertEqual(state["status"], "Command failed")
            self.assertIn("Managed uv runtime is unavailable", state["lastError"])

    def test_widget_launch_uses_clean_uv_workspace_run_after_sync(self):
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
                return normalized in {
                    uv_bin,
                    "/tmp/dartsnut-python-test",
                    str(venv_python),
                }

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
                        "VIRTUAL_ENV": "/host/venv",
                        "PYTHONHOME": "/host/python",
                        "PYTHONPATH": "/host/packages",
                        "PYTHONUSERBASE": "/host/userbase",
                        "UV_NO_SYNC": "1",
                        "UV_NO_PROJECT": "1",
                        "UV_PROJECT_ENVIRONMENT": "/other/venv",
                    },
                    clear=False,
                ),
                mock.patch.object(module.subprocess, "Popen", side_effect=fake_popen),
            ):
                core.apply_command({"type": "reload_widget"})

            command = captured.get("command", [])
            child_env = captured.get("env", {})
            for key in (
                "VIRTUAL_ENV",
                "PYTHONHOME",
                "PYTHONPATH",
                "PYTHONUSERBASE",
                "UV_NO_SYNC",
                "UV_NO_PROJECT",
                "UV_PROJECT_ENVIRONMENT",
            ):
                self.assertNotIn(key, child_env)
            self.assertEqual(child_env.get("PYTHONNOUSERSITE"), "1")
            self.assertEqual(command[0], uv_bin)
            self.assertEqual(command[1:5], ["run", "--no-sync", "--directory", str(demo_dir)])
            self.assertEqual(command[5], "main.py")


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
                _managed_runtime(module),
                mock.patch.object(module.time, "sleep", lambda _: None),
                mock.patch.object(module.EmulatorCore, "_ensure_workspace_venv", return_value=True),
                mock.patch.object(module.subprocess, "Popen", side_effect=_capture_popen),
            ):
                core.start_widget_process_for_current()

            env = captured.get("env")
            self.assertIsInstance(env, dict)
            assert isinstance(env, dict)
            self.assertEqual(env.get("SDL_VIDEODRIVER"), "dummy")
            self.assertNotIn("SDL_AUDIODRIVER", env)

    def test_muted_widget_launch_uses_dummy_audio(self):
        module = _load_core_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_widget_conf(workspace, "demo")
            (workspace / "demo" / "main.py").write_text("print('ok')\n", encoding="utf-8")
            with mock.patch.object(module.EmulatorCore, "_init_shared_memory", lambda self: None):
                core = module.EmulatorCore(workspace_root=str(workspace))
            self.addCleanup(core.shutdown)

            core.apply_command({"type": "set_path", "path": "demo"})
            core.apply_command({"type": "set_audio_muted", "muted": True})
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
                _managed_runtime(module),
                mock.patch.object(module.time, "sleep", lambda _: None),
                mock.patch.object(module.EmulatorCore, "_ensure_workspace_venv", return_value=True),
                mock.patch.object(module.subprocess, "Popen", side_effect=_capture_popen),
            ):
                core.start_widget_process_for_current()

            env = captured.get("env")
            self.assertIsInstance(env, dict)
            assert isinstance(env, dict)
            self.assertEqual(env.get("SDL_AUDIODRIVER"), "dummy")

    def test_unmuting_clears_dummy_audio_for_next_launch(self):
        module = _load_core_module()
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            _write_widget_conf(workspace, "demo")
            (workspace / "demo" / "main.py").write_text("print('ok')\n", encoding="utf-8")
            with mock.patch.object(module.EmulatorCore, "_init_shared_memory", lambda self: None):
                core = module.EmulatorCore(workspace_root=str(workspace))
            self.addCleanup(core.shutdown)

            core.apply_command({"type": "set_path", "path": "demo"})
            core.apply_command({"type": "set_audio_muted", "muted": True})
            state = core.apply_command({"type": "set_audio_muted", "muted": False})
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
                _managed_runtime(module),
                mock.patch.object(module.time, "sleep", lambda _: None),
                mock.patch.dict(module.os.environ, {"SDL_AUDIODRIVER": "coreaudio"}, clear=False),
                mock.patch.object(module.EmulatorCore, "_ensure_workspace_venv", return_value=True),
                mock.patch.object(module.subprocess, "Popen", side_effect=_capture_popen),
            ):
                core.start_widget_process_for_current()

            env = captured.get("env")
            self.assertFalse(state["audioMuted"])
            self.assertIsInstance(env, dict)
            assert isinstance(env, dict)
            self.assertNotIn("SDL_AUDIODRIVER", env)

    def test_toggling_audio_mute_restarts_running_widget(self):
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
            launched: list[object] = []

            def _capture_popen(*args, **kwargs):
                new_proc = mock.MagicMock()
                new_proc.poll.return_value = 0
                new_proc.stdout = None
                new_proc.stderr = None
                new_proc.pid = 4243
                launched.append(new_proc)
                return new_proc

            with (
                _managed_runtime(module),
                mock.patch.object(module.time, "sleep", lambda _: None),
                mock.patch.object(module, "_kill_process_tree") as kill_tree,
                mock.patch.object(module.EmulatorCore, "_ensure_workspace_venv", return_value=True),
                mock.patch.object(module.subprocess, "Popen", side_effect=_capture_popen),
            ):
                state = core.apply_command({"type": "set_audio_muted", "muted": True})

            self.assertTrue(state["audioMuted"])
            kill_tree.assert_called_once_with(proc, force=False)
            self.assertEqual(len(launched), 1)


if __name__ == "__main__":
    unittest.main()
