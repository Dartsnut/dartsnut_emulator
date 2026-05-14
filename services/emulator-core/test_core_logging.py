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


if __name__ == "__main__":
    unittest.main()
