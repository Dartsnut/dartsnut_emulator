"""Regression tests for emulator screenshot capture."""

from __future__ import annotations

import importlib.util
import base64
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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
                for pattern in ("TestApp*.png", "TestApp*.gif"):
                    for path in folder.glob(pattern):
                        path.unlink(missing_ok=True)
        self.temp_dir.cleanup()

    def test_game_capture_writes_mockup_and_surface(self):
        self.core.state.widgetType = "game"
        self.core._last_frame_w = 128
        self.core._last_frame_h = 160
        self.core._last_frame_bytes = _solid_frame_bytes(128, 160)

        filepaths = self.core._capture_screenshot_png()

        self.assertEqual(len(filepaths), 2)
        mockup_path, surface_path = filepaths
        self.assertIn("_surface_", surface_path)
        self.assertNotIn("_surface_", mockup_path)
        self.assertEqual(
            Path(mockup_path).stem.removeprefix("TestApp_"),
            Path(surface_path).stem.removeprefix("TestApp_surface_"),
        )

        with Image.open(mockup_path) as mockup:
            self.assertEqual(mockup.size, (588, 800))
        with Image.open(surface_path) as surface:
            self.assertEqual(surface.size, (128, 160))

        self.assertTrue(Path(mockup_path).exists())
        self.assertTrue(Path(surface_path).exists())

    def test_128x160_widget_capture_writes_mockup_and_surface(self):
        self.core.state.widgetType = "widget"
        self.core._last_frame_w = 128
        self.core._last_frame_h = 160
        self.core._last_frame_bytes = _solid_frame_bytes(128, 160)

        filepaths = self.core._capture_screenshot_png()

        self.assertEqual(len(filepaths), 2)
        mockup_path, surface_path = filepaths
        self.assertIn("_surface_", surface_path)
        self.assertNotIn("_surface_", mockup_path)

        with Image.open(mockup_path) as mockup:
            self.assertEqual(mockup.size, (588, 800))
        with Image.open(surface_path) as surface:
            self.assertEqual(surface.size, (128, 160))

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

    def test_128x64_screenshot_surface_respects_zoom(self):
        self.core.state.widgetType = "widget"
        self.core._last_frame_w = 128
        self.core._last_frame_h = 64
        self.core._last_frame_bytes = _solid_frame_bytes(128, 64)

        for zoom, expected in ((1, (128, 64)), (2, (256, 128)), (4, (512, 256))):
            with self.subTest(zoom=zoom):
                paths = self.core._capture_screenshot_png(zoom=zoom)
                with Image.open(paths[1]) as surface:
                    self.assertEqual(surface.size, expected)
                for path in paths:
                    Path(path).unlink(missing_ok=True)

    def test_gif_panel_specs_cover_supported_sizes(self):
        expected = {
            (128, 160): [("main", (0, 0, 128, 128)), ("bottom", (0, 128, 64, 160))],
            (128, 128): [(None, (0, 0, 128, 128))],
            (128, 64): [(None, (0, 0, 128, 64))],
            (64, 32): [(None, (0, 0, 64, 32))],
        }
        for size, panels in expected.items():
            with self.subTest(size=size):
                self.assertEqual(self.core._gif_panel_specs(*size), panels)

    def test_gif_save_splits_128x160_and_applies_zoom(self):
        top = _solid_frame_bytes(128, 128, (255, 0, 0))
        bottom = _solid_frame_bytes(64, 32, (0, 0, 0))
        frame = top + bottom + bytes((128 - 64) * 32 * 3)

        paths = self.core._save_gif_files(
            [frame, frame], 128, 160, 2, "TestApp", "gif-test"
        )

        self.assertEqual(len(paths), 2)
        self.assertIn("_main_", paths[0])
        self.assertIn("_bottom_", paths[1])
        with Image.open(paths[0]) as main:
            self.assertEqual(main.size, (256, 256))
            self.assertEqual(main.convert("RGB").getpixel((0, 0)), (255, 0, 0))
        with Image.open(paths[1]) as bottom_gif:
            self.assertEqual(bottom_gif.size, (128, 64))
            self.assertEqual(bottom_gif.convert("RGB").getpixel((0, 0)), (0, 0, 0))

    def test_single_panel_gif_sizes_apply_every_zoom(self):
        for width, height in ((128, 128), (128, 64), (64, 32)):
            frame = _solid_frame_bytes(width, height)
            for zoom in (1, 2, 4):
                with self.subTest(size=(width, height), zoom=zoom):
                    paths = self.core._save_gif_files(
                        [frame], width, height, zoom, "TestApp", f"{width}x{height}-{zoom}x"
                    )
                    self.assertEqual(len(paths), 1)
                    with Image.open(paths[0]) as image:
                        self.assertEqual(image.size, (width * zoom, height * zoom))
                        self.assertNotIn("transparency", image.info)

    def test_gif_durations_total_one_second_per_24_frames(self):
        durations = self.core._gif_frame_durations(24)

        self.assertEqual(len(durations), 24)
        self.assertEqual(sum(durations), 1000)
        self.assertEqual(set(durations), {40, 50})

    def test_gif_sampler_duplicates_slow_frames_and_drops_fast_frames(self):
        first = _solid_frame_bytes(2, 1, (10, 10, 10))
        second = _solid_frame_bytes(2, 1, (20, 20, 20))
        third = _solid_frame_bytes(2, 1, (30, 30, 30))
        self.core._last_frame_w = 2
        self.core._last_frame_h = 1
        self.core._last_frame_bytes = first
        self.core._start_gif_recording(1, now=100.0)

        self.core._last_frame_bytes = second
        self.core.update_gif_recording(now=100.5)
        self.assertEqual(len(self.core._gif_frames), 12)
        self.assertTrue(all(frame == second for frame in self.core._gif_frames[1:]))

        self.core._last_frame_bytes = third
        self.core.update_gif_recording(now=101.0)
        self.assertEqual(len(self.core._gif_frames), 24)
        self.assertTrue(all(frame == third for frame in self.core._gif_frames[12:]))
        self.core.state.gifRecording = False
        self.core._gif_frames = []

    def test_gif_recording_auto_stops_at_720_frames(self):
        self.core._last_frame_w = 2
        self.core._last_frame_h = 1
        self.core._last_frame_bytes = _solid_frame_bytes(2, 1)
        self.core._start_gif_recording(1, now=10.0)

        with mock.patch.object(self.core, "_finish_gif_recording") as finish:
            self.core.update_gif_recording(now=40.0)

        self.assertEqual(len(self.core._gif_frames), 720)
        self.assertEqual(self.core.state.gifElapsedMs, 30_000)
        finish.assert_called_once_with()
        self.core.state.gifRecording = False
        self.core._gif_frames = []

    def test_gif_start_requires_frame_and_rejects_duplicate_start(self):
        self.core._last_frame_bytes = None
        with self.assertRaisesRegex(ValueError, "No frame available"):
            self.core._start_gif_recording(1, now=1.0)

        self.core._last_frame_bytes = _solid_frame_bytes(64, 32)
        self.core._start_gif_recording(1, now=1.0)
        with self.assertRaisesRegex(ValueError, "already active"):
            self.core._start_gif_recording(1, now=1.0)
        self.core.state.gifRecording = False
        self.core._gif_frames = []

    def test_gif_finish_reports_async_saving_and_completion(self):
        self.core._start_gif_recording(1, now=1.0)
        fake_paths = [str(self.workspace / "TestApp.gif")]
        with mock.patch.object(self.core, "_save_gif_files", return_value=fake_paths):
            self.core._finish_gif_recording()
            self.assertFalse(self.core.state.gifRecording)
            self.assertTrue(self.core.state.gifSaving)
            self.assertEqual(self.core.state.status, "Saving GIF")
            self.core._gif_save_thread.join(timeout=2)

        self.assertTrue(self.core.poll_gif_save_result())
        self.assertFalse(self.core.state.gifSaving)
        self.assertEqual(self.core.state.status, "GIF recorded: TestApp.gif")
        self.assertEqual(self.core.state.lastCapturePath, str(self.workspace))

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
