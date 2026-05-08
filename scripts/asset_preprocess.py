#!/usr/bin/env python3
"""Preprocess a user-supplied image into per-frame PNGs for the Dartsnut asset pipeline.

CLI surface (invoked by Electron main):

    python scripts/asset_preprocess.py \
        --slot <id> \
        --kind static|gif|spritesheet \
        --size WxH \
        --frames N \
        --source <absolute path to source image> \
        --workspace <absolute path to workspace root>

Outputs are written under the workspace:

    assets/_sources/<slot-id>.<ext>     # original source (overwritten on re-bind)
    assets/<slot-id>/frame_NNN.png      # zero-padded per-frame PNGs
    assets/<slot-id>/meta.json          # { "frames": N, "durations_ms"?: [..] }

The script always prints exactly one structured JSON line on stdout and exits 0,
regardless of success or failure. Errors are signaled via `{ "ok": false,
"slotId": "...", "code": "...", "message": "..." }`. This avoids having callers
parse Python tracebacks and lets the desktop pipeline render friendly inline
errors keyed off `code`.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Optional


ERROR_CODES = (
    "manifest_missing",
    "slot_not_found",
    "unreadable_image",
    "dimension_mismatch",
    "frame_count_mismatch",
    "pillow_unavailable",
    "io_error",
    "preprocessor_crashed",
)


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")))
    sys.stdout.write("\n")
    sys.stdout.flush()


def _err(slot_id: str, code: str, message: str) -> dict:
    return {"ok": False, "slotId": slot_id, "code": code, "message": message}


def _parse_size(raw: str) -> tuple[int, int]:
    parts = raw.lower().split("x")
    if len(parts) != 2:
        raise ValueError(f"--size must be WxH, got: {raw}")
    w, h = int(parts[0]), int(parts[1])
    if w <= 0 or h <= 0:
        raise ValueError(f"--size must be positive, got: {raw}")
    return w, h


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Dartsnut asset preprocessor")
    parser.add_argument("--slot", required=True)
    parser.add_argument("--kind", required=True, choices=("static", "gif", "spritesheet"))
    parser.add_argument("--size", required=True, help="WxH single-frame size in pixels")
    parser.add_argument("--frames", required=True, type=int)
    parser.add_argument("--source", required=True)
    parser.add_argument("--workspace", required=True)
    return parser


def run_cli(argv: Optional[list[str]] = None) -> int:
    """Entry point used by both the CLI and the test suite."""

    parser = _build_arg_parser()
    args = parser.parse_args(argv)

    slot_id = args.slot
    workspace = Path(args.workspace)
    source = Path(args.source)
    kind = args.kind
    declared_frames = int(args.frames)

    if not workspace.exists() or not workspace.is_dir():
        _emit(_err(slot_id, "io_error", f"workspace not found: {workspace}"))
        return 0

    if not source.exists() or not source.is_file():
        _emit(_err(slot_id, "io_error", f"source file not found: {source}"))
        return 0

    try:
        size = _parse_size(args.size)
    except ValueError as exc:
        _emit(_err(slot_id, "io_error", str(exc)))
        return 0

    if declared_frames < 1:
        _emit(_err(slot_id, "frame_count_mismatch", "frames must be >= 1"))
        return 0
    if kind == "static" and declared_frames != 1:
        _emit(_err(slot_id, "frame_count_mismatch", "static slot must declare frames=1"))
        return 0

    try:
        from PIL import Image, ImageSequence
    except ImportError as exc:
        _emit(_err(slot_id, "pillow_unavailable", f"Pillow is not available: {exc}"))
        return 0

    try:
        return _process(
            Image=Image,
            ImageSequence=ImageSequence,
            slot_id=slot_id,
            kind=kind,
            size=size,
            declared_frames=declared_frames,
            source=source,
            workspace=workspace,
        )
    except Exception as exc:  # noqa: BLE001 - want to capture-and-report all failures
        _emit(_err(slot_id, "preprocessor_crashed", f"unexpected failure: {exc}"))
        return 0


def _process(
    *,
    Image,
    ImageSequence,
    slot_id: str,
    kind: str,
    size: tuple[int, int],
    declared_frames: int,
    source: Path,
    workspace: Path,
) -> int:
    width, height = size

    try:
        with Image.open(source) as opened:
            opened.load()  # force decoding so corrupt files surface immediately
    except Exception as exc:  # noqa: BLE001 - includes UnidentifiedImageError, OSError, etc.
        _emit(_err(slot_id, "unreadable_image", f"cannot read image: {exc}"))
        return 0

    # Stage inside `<workspace>/assets/.tmp/` so the workspace-root manifest
    # watcher does not see staging files churn alongside `dartsnut.assets.json`.
    staging_parent = workspace / "assets" / ".tmp"
    staging_parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(tempfile.mkdtemp(prefix=f"asset-{slot_id}-", dir=str(staging_parent)))
    staging_slot_dir = staging_root / "slot"
    staging_slot_dir.mkdir(parents=True, exist_ok=True)

    try:
        if kind == "static":
            outcome = _process_static(
                Image=Image,
                slot_id=slot_id,
                size=(width, height),
                source=source,
                staging_slot_dir=staging_slot_dir,
            )
        elif kind == "gif":
            outcome = _process_gif(
                Image=Image,
                ImageSequence=ImageSequence,
                slot_id=slot_id,
                size=(width, height),
                declared_frames=declared_frames,
                source=source,
                staging_slot_dir=staging_slot_dir,
            )
        else:
            outcome = _process_spritesheet(
                Image=Image,
                slot_id=slot_id,
                size=(width, height),
                declared_frames=declared_frames,
                source=source,
                staging_slot_dir=staging_slot_dir,
            )
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(staging_root, ignore_errors=True)
        _emit(_err(slot_id, "preprocessor_crashed", f"unexpected failure: {exc}"))
        return 0

    if outcome is None:
        # `_process_*` already emitted the structured failure payload.
        shutil.rmtree(staging_root, ignore_errors=True)
        return 0

    frames_count, durations_ms = outcome

    meta = {"frames": frames_count}
    if durations_ms is not None:
        meta["durations_ms"] = durations_ms
    (staging_slot_dir / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))

    sources_dir = workspace / "assets" / "_sources"
    final_slot_dir = workspace / "assets" / slot_id
    final_source_path = sources_dir / f"{slot_id}{source.suffix.lower()}"

    try:
        sources_dir.mkdir(parents=True, exist_ok=True)
        # Drop any prior frame outputs so re-bind doesn't leave stale frames behind
        # (e.g. previous bind had 6 frames, new one has 4).
        if final_slot_dir.exists():
            shutil.rmtree(final_slot_dir)
        # Remove any prior source file for this slot (might have a different extension).
        for prior in sources_dir.glob(f"{slot_id}.*"):
            prior.unlink()
        shutil.copy2(source, final_source_path)
        shutil.move(str(staging_slot_dir), str(final_slot_dir))
    except OSError as exc:
        shutil.rmtree(staging_root, ignore_errors=True)
        _emit(_err(slot_id, "io_error", f"failed to commit outputs: {exc}"))
        return 0
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)

    frame_rel_paths = [
        f"assets/{slot_id}/frame_{i:03d}.png" for i in range(frames_count)
    ]
    binding = {
        "source": f"assets/_sources/{slot_id}{source.suffix.lower()}",
        "frames": frame_rel_paths,
        "meta": f"assets/{slot_id}/meta.json",
    }
    _emit({
        "ok": True,
        "slotId": slot_id,
        "kind": kind,
        "frames": frames_count,
        "binding": binding,
    })
    return 0


def _process_static(*, Image, slot_id, size, source, staging_slot_dir):
    width, height = size
    with Image.open(source) as raw:
        if raw.size != (width, height):
            _emit(_err(
                slot_id,
                "dimension_mismatch",
                f"expected {width}x{height}, got {raw.size[0]}x{raw.size[1]}",
            ))
            return None
        raw.convert("RGBA").save(staging_slot_dir / "frame_000.png", format="PNG")
    return 1, None


def _process_gif(*, Image, ImageSequence, slot_id, size, declared_frames, source, staging_slot_dir):
    width, height = size
    with Image.open(source) as img:
        frames = list(ImageSequence.Iterator(img))
        if len(frames) != declared_frames:
            _emit(_err(
                slot_id,
                "frame_count_mismatch",
                f"declared {declared_frames} frames, got {len(frames)}",
            ))
            return None
        durations_ms: list[int] = []
        for index, frame in enumerate(frames):
            rgba = frame.convert("RGBA")
            if rgba.size != (width, height):
                _emit(_err(
                    slot_id,
                    "dimension_mismatch",
                    f"frame {index}: expected {width}x{height}, got {rgba.size[0]}x{rgba.size[1]}",
                ))
                return None
            rgba.save(staging_slot_dir / f"frame_{index:03d}.png", format="PNG")
            # PIL exposes per-frame duration on the source frame's `info`.
            duration = frame.info.get("duration") if hasattr(frame, "info") else None
            if isinstance(duration, (int, float)) and duration > 0:
                durations_ms.append(int(duration))
            else:
                durations_ms.append(100)
    return declared_frames, durations_ms


def _process_spritesheet(*, Image, slot_id, size, declared_frames, source, staging_slot_dir):
    width, height = size
    with Image.open(source) as raw:
        expected = (width * declared_frames, height)
        if raw.size != expected:
            _emit(_err(
                slot_id,
                "dimension_mismatch",
                f"expected {expected[0]}x{expected[1]} (size*frames horizontal), got {raw.size[0]}x{raw.size[1]}",
            ))
            return None
        sheet = raw.convert("RGBA")
    for index in range(declared_frames):
        left = width * index
        crop = sheet.crop((left, 0, left + width, height))
        crop.save(staging_slot_dir / f"frame_{index:03d}.png", format="PNG")
    return declared_frames, None


def main() -> None:
    sys.exit(run_cli())


if __name__ == "__main__":
    main()
