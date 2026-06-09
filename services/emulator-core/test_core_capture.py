"""Regression tests for emulator screenshot capture."""

from __future__ import annotations

import importlib.util
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
        self.temp_dir.cleanup()

    def test_game_capture_writes_mockup_only(self):
        self.core.state.widgetType = "game"

        filepaths = self.core._capture_screenshot_png()

        self.assertEqual(len(filepaths), 1)
        with Image.open(filepaths[0]) as mockup:
            self.assertEqual(mockup.size, (588, 800))

        capture_dir = self.workspace / "capture"
        self.assertEqual(len(list(capture_dir.glob("*.png"))), 1)

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

        capture_dir = self.workspace / "capture"
        self.assertEqual(len(list(capture_dir.glob("*.png"))), 2)

    def test_widget_capture_uses_shared_timestamp(self):
        self.core.state.widgetType = "widget"

        filepaths = self.core._capture_screenshot_png()

        mockup_stem = Path(filepaths[0]).stem
        surface_stem = Path(filepaths[1]).stem
        self.assertTrue(mockup_stem.startswith("TestApp_"))
        self.assertTrue(surface_stem.startswith("TestApp_surface_"))
        self.assertEqual(mockup_stem.removeprefix("TestApp_"), surface_stem.removeprefix("TestApp_surface_"))


if __name__ == "__main__":
    unittest.main()
