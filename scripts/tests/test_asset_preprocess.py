"""Tests for scripts/asset_preprocess.py.

Run with the project venv:
    .venv/bin/python -m unittest scripts.tests.test_asset_preprocess
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from PIL import Image


SCRIPTS_DIR = Path(__file__).resolve().parent.parent
SCRIPT_PATH = SCRIPTS_DIR / "asset_preprocess.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("asset_preprocess", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load module spec from {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("asset_preprocess", module)
    spec.loader.exec_module(module)
    return module


def _run_cli(argv):
    module = _load_module()
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        exit_code = module.run_cli(argv)
    self_text = buffer.getvalue().strip()
    payload = json.loads(self_text) if self_text else None
    return exit_code, payload


def _make_static_png(path: Path, size=(16, 16), color=(255, 0, 0)):
    Image.new("RGBA", size, color + (255,)).save(path)


def _make_gif(path: Path, size=(16, 16), frames=4, durations=None):
    if durations is None:
        durations = [80, 80, 80, 80]
    images = []
    for i in range(frames):
        shade = 50 + (i * 50) % 200
        images.append(Image.new("RGB", size, (shade, shade, shade)))
    images[0].save(
        path,
        save_all=True,
        append_images=images[1:],
        duration=durations,
        loop=0,
        format="GIF",
    )


def _make_spritesheet(path: Path, frame_size=(16, 16), frames=4):
    sheet = Image.new("RGBA", (frame_size[0] * frames, frame_size[1]), (0, 0, 0, 0))
    for i in range(frames):
        tile_color = (40 * (i + 1) % 256, (i * 60) % 256, 200, 255)
        tile = Image.new("RGBA", frame_size, tile_color)
        sheet.paste(tile, (frame_size[0] * i, 0))
    sheet.save(path)


class StaticBranchTests(unittest.TestCase):
    def test_success_writes_outputs_and_returns_ok(self):
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            source = workspace / "input.png"
            _make_static_png(source, size=(16, 16))
            exit_code, payload = _run_cli([
                "--slot", "player",
                "--kind", "static",
                "--size", "16x16",
                "--frames", "1",
                "--source", str(source),
                "--workspace", str(workspace),
            ])
            self.assertEqual(exit_code, 0)
            self.assertIsNotNone(payload)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["slotId"], "player")
            self.assertEqual(payload["frames"], 1)
            self.assertEqual(payload["binding"]["frames"][0], "assets/player/frame_000.png")
            self.assertEqual(payload["binding"]["meta"], "assets/player/meta.json")
            self.assertEqual(payload["binding"]["source"], "assets/_sources/player.png")
            self.assertTrue((workspace / "assets" / "_sources" / "player.png").exists())
            self.assertTrue((workspace / "assets" / "player" / "frame_000.png").exists())
            meta = json.loads((workspace / "assets" / "player" / "meta.json").read_text())
            self.assertEqual(meta["frames"], 1)

    def test_dimension_mismatch_returns_error_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            source = workspace / "input.png"
            _make_static_png(source, size=(32, 32))
            exit_code, payload = _run_cli([
                "--slot", "player",
                "--kind", "static",
                "--size", "16x16",
                "--frames", "1",
                "--source", str(source),
                "--workspace", str(workspace),
            ])
            self.assertEqual(exit_code, 0)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["code"], "dimension_mismatch")
            self.assertEqual(payload["slotId"], "player")
            self.assertFalse((workspace / "assets" / "_sources").exists())
            self.assertFalse((workspace / "assets" / "player").exists())


class GifBranchTests(unittest.TestCase):
    def test_success_writes_per_frame_pngs_and_durations(self):
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            source = workspace / "input.gif"
            _make_gif(source, size=(16, 16), frames=4, durations=[80, 100, 120, 140])
            exit_code, payload = _run_cli([
                "--slot", "boss",
                "--kind", "gif",
                "--size", "16x16",
                "--frames", "4",
                "--source", str(source),
                "--workspace", str(workspace),
            ])
            self.assertEqual(exit_code, 0)
            self.assertTrue(payload["ok"], payload)
            slot_dir = workspace / "assets" / "boss"
            for i in range(4):
                self.assertTrue((slot_dir / f"frame_{i:03d}.png").exists())
            meta = json.loads((slot_dir / "meta.json").read_text())
            self.assertEqual(meta["frames"], 4)
            self.assertEqual(len(meta["durations_ms"]), 4)
            for ms in meta["durations_ms"]:
                self.assertGreater(ms, 0)

    def test_frame_count_mismatch(self):
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            source = workspace / "input.gif"
            _make_gif(source, size=(16, 16), frames=4)
            exit_code, payload = _run_cli([
                "--slot", "boss",
                "--kind", "gif",
                "--size", "16x16",
                "--frames", "3",
                "--source", str(source),
                "--workspace", str(workspace),
            ])
            self.assertEqual(exit_code, 0)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["code"], "frame_count_mismatch")
            self.assertFalse((workspace / "assets" / "boss").exists())
            self.assertFalse((workspace / "assets" / "_sources").exists())


class SpritesheetBranchTests(unittest.TestCase):
    def test_success_slices_horizontally(self):
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            source = workspace / "sheet.png"
            _make_spritesheet(source, frame_size=(16, 16), frames=4)
            exit_code, payload = _run_cli([
                "--slot", "coin",
                "--kind", "spritesheet",
                "--size", "16x16",
                "--frames", "4",
                "--source", str(source),
                "--workspace", str(workspace),
            ])
            self.assertEqual(exit_code, 0)
            self.assertTrue(payload["ok"], payload)
            slot_dir = workspace / "assets" / "coin"
            for i in range(4):
                self.assertTrue((slot_dir / f"frame_{i:03d}.png").exists())
            self.assertEqual(json.loads((slot_dir / "meta.json").read_text())["frames"], 4)

    def test_wrong_total_dimensions(self):
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            source = workspace / "sheet.png"
            _make_static_png(source, size=(50, 16))
            exit_code, payload = _run_cli([
                "--slot", "coin",
                "--kind", "spritesheet",
                "--size", "16x16",
                "--frames", "4",
                "--source", str(source),
                "--workspace", str(workspace),
            ])
            self.assertEqual(exit_code, 0)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["code"], "dimension_mismatch")
            self.assertFalse((workspace / "assets" / "coin").exists())


class UnreadableImageTests(unittest.TestCase):
    def test_corrupt_source_returns_unreadable_error(self):
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            source = workspace / "garbage.png"
            source.write_bytes(b"not really a png")
            exit_code, payload = _run_cli([
                "--slot", "broken",
                "--kind", "static",
                "--size", "16x16",
                "--frames", "1",
                "--source", str(source),
                "--workspace", str(workspace),
            ])
            self.assertEqual(exit_code, 0)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["code"], "unreadable_image")


class ReBindTests(unittest.TestCase):
    def test_rebind_overwrites_previous_outputs(self):
        with tempfile.TemporaryDirectory() as workspace_dir:
            workspace = Path(workspace_dir)
            source_a = workspace / "a.png"
            source_b = workspace / "b.png"
            _make_static_png(source_a, size=(16, 16), color=(10, 10, 10))
            _make_static_png(source_b, size=(16, 16), color=(200, 200, 200))

            for src in (source_a, source_b):
                exit_code, payload = _run_cli([
                    "--slot", "tile",
                    "--kind", "static",
                    "--size", "16x16",
                    "--frames", "1",
                    "--source", str(src),
                    "--workspace", str(workspace),
                ])
                self.assertEqual(exit_code, 0)
                self.assertTrue(payload["ok"], payload)

            # After re-bind, the source should match `b.png` color.
            final = Image.open(workspace / "assets" / "_sources" / "tile.png").convert("RGB")
            r, g, b = final.getpixel((0, 0))
            self.assertGreater(r, 100)
            self.assertGreater(g, 100)
            self.assertGreater(b, 100)


if __name__ == "__main__":
    unittest.main()
