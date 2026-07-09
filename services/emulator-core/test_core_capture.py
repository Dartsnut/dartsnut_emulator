"""Regression tests for emulator screenshot capture."""

from __future__ import annotations

import importlib.util
import base64
import tempfile
import unittest
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parent
CORE_PATH = ROOT / "core.py"


def _load_core_module():
    spec = importlib.util.spec_from_file_location("emulator_core", CORE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module spec from {CORE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _solid_frame_bytes(width: int, height: int, rgb: tuple[int, int, int] = (40, 80, 120)) -> bytes:
    r, g, b = rgb
    return bytes([r, g, b] * (width * height))


class CaptureScreenshotTests(unittest.TestCase):
    def setUp(self):
        self.module = _load_core_module()
        self.temp_dir = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp_dir.name)
        self.core = self.module.EmulatorCore(workspace_root=str(self.workspace))
        self.core.capture_base_name = "TestApp"
        self.core._last_frame_w = 64
        self.core._last_frame_h = 32
        self.core._last_frame_bytes = _solid_frame_bytes(64, 32)

    def tearDown(self):
        self.core.shutdown()
        for folder in [self.workspace / "capture", Path.home() / "Downloads" / "Dartsnut"]:
            if folder.exists():
                for path in folder.glob("TestApp*.png"):
                    path.unlink(missing_ok=True)
        self.temp_dir.cleanup()

    def test_game_capture_writes_mockup_only(self):
        self.core.state.widgetType = "game"

        filepaths = self.core._capture_screenshot_png()

        self.assertEqual(len(filepaths), 1)
        with Image.open(filepaths[0]) as mockup:
            self.assertEqual(mockup.size, (588, 800))

        self.assertTrue(Path(filepaths[0]).exists())

    def test_widget_capture_writes_mockup_and_surface(self):
        self.core.state.widgetType = "widget"

        filepaths = self.core._capture_screenshot_png()

        self.assertEqual(len(filepaths), 2)
        mockup_path, surface_path = filepaths
        self.assertIn("_surface_", surface_path)
        self.assertNotIn("_surface_", mockup_path)

        with Image.open(mockup_path) as mockup:
            self.assertEqual(mockup.size, (588, 800))
        with Image.open(surface_path) as surface:
            self.assertEqual(surface.size, (256, 128))

        self.assertTrue(Path(mockup_path).exists())
        self.assertTrue(Path(surface_path).exists())

    def test_widget_capture_uses_shared_timestamp(self):
        self.core.state.widgetType = "widget"

        filepaths = self.core._capture_screenshot_png()

        mockup_stem = Path(filepaths[0]).stem
        surface_stem = Path(filepaths[1]).stem
        self.assertTrue(mockup_stem.startswith("TestApp_"))
        self.assertTrue(surface_stem.startswith("TestApp_surface_"))
        self.assertEqual(mockup_stem.removeprefix("TestApp_"), surface_stem.removeprefix("TestApp_surface_"))

    def test_capture_screenshot_payload_returns_png_base64_without_writing_files(self):
        self.core.state.widgetType = "widget"

        payload = self.core.capture_screenshot_payload(include_hardware=True)

        self.assertEqual(payload["surface"]["width"], 64)
        self.assertEqual(payload["surface"]["height"], 32)
        self.assertTrue(base64.b64decode(payload["surface"]["pngBase64"]).startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(payload["hardware"]["width"], 588)
        self.assertEqual(payload["hardware"]["height"], 800)
        self.assertFalse((self.workspace / "capture").exists())

    def test_input_commands_update_internal_state_for_agent_controls(self):
        self.core.apply_command({"type": "set_button", "button": "A", "pressed": True})
        self.core.apply_command({"type": "throw_dart", "index": 0, "x": 10, "y": 20})

        self.assertEqual(self.core._button_state & 0x01, 0x01)
        self.assertEqual(self.core._darts[0], [10, 20])

        self.core.apply_command({"type": "remove_dart_at", "x": 10, "y": 20})
        self.core.apply_command({"type": "clear_darts"})
        self.core.apply_command({"type": "set_button", "button": "A", "pressed": False})

        self.assertEqual(self.core._button_state & 0x01, 0)
        self.assertTrue(all(slot == [-1, -1] for slot in self.core._darts))


if __name__ == "__main__":
    unittest.main()
