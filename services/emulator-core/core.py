import base64
import json
import os
import queue
import subprocess
import sys
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from multiprocessing import shared_memory
from typing import Any

from PIL import Image, ImageDraw


def sanitize_name(name: str) -> str:
    if not name:
        return "capture"
    invalid_chars = '<>:"/\\|?*'
    sanitized = "".join("_" if c in invalid_chars else c for c in name)
    sanitized = "_".join(sanitized.split())
    return sanitized or "capture"


@dataclass
class EmulatorState:
    widgetPath: str | None = None
    widgetId: str | None = None
    widgetType: str | None = None
    running: bool = False
    fps: int = 60
    status: str = "Idle"
    lastError: str | None = None


class EmulatorCore:
    def __init__(self, workspace_root: str):
        self.workspace_root = workspace_root
        self.widget_process: subprocess.Popen[Any] | None = None
        self.current_path: str | None = None
        self.current_params: dict[str, Any] = {}
        self.config: dict[str, Any] | None = None
        self.data_store_path: str | None = None
        self.state = EmulatorState()
        self.shm_pdi_name = "shmpdi"
        self.shm_pdo_name = "pdoshm"
        self.shm_pdi: shared_memory.SharedMemory | None = None
        self.shm_pdo: shared_memory.SharedMemory | None = None
        self._widget_output_tail = ""
        self._widget_stream_tail = ""
        self._pending_widget_logs: list[dict[str, Any]] = []
        self._widget_log_queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self._log_reader_threads: list[threading.Thread] = []
        self._last_frame_bytes: bytes | None = None
        self._last_frame_w = 128
        self._last_frame_h = 160
        self.capture_base_name = "capture"
        self._button_state = 0
        self._darts: list[list[int]] = [[-1, -1] for _ in range(12)]
        self._init_shared_memory()

    def _cleanup_shared_memory_name(self, name: str) -> None:
        try:
            existing = shared_memory.SharedMemory(name=name)
            existing.close()
            existing.unlink()
        except FileNotFoundError:
            return

    def _init_shared_memory(self) -> None:
        self._cleanup_shared_memory_name(self.shm_pdi_name)
        self._cleanup_shared_memory_name(self.shm_pdo_name)
        self.shm_pdi = shared_memory.SharedMemory(
            name=self.shm_pdi_name, create=True, size=128 * 160 * 3 + 1
        )
        self.shm_pdi.buf[0] = 1
        self.shm_pdo = shared_memory.SharedMemory(name=self.shm_pdo_name, create=True, size=49)
        self._write_button_state()
        self._write_all_darts()

    def _write_button_state(self) -> None:
        if self.shm_pdo is None:
            return
        self.shm_pdo.buf[0] = self._button_state & 0xFF

    def _write_all_darts(self) -> None:
        if self.shm_pdo is None:
            return
        for i, (x, y) in enumerate(self._darts):
            base = i * 4 + 1
            if x < 0 or y < 0:
                self.shm_pdo.buf[base : base + 2] = (0xFFFF).to_bytes(2, "little")
                self.shm_pdo.buf[base + 2 : base + 4] = (0xFFFF).to_bytes(2, "little")
            else:
                self.shm_pdo.buf[base : base + 2] = int(x).to_bytes(2, "little")
                self.shm_pdo.buf[base + 2 : base + 4] = int(y).to_bytes(2, "little")

    def snapshot(self) -> dict[str, Any]:
        if self.widget_process is not None and self.widget_process.poll() is not None:
            self._stop_widget_log_readers(join_timeout=5.0)
            if self._widget_stream_tail.strip():
                self._widget_output_tail = self._widget_stream_tail[-2000:]
                self.state.lastError = self._widget_output_tail
            self._widget_stream_tail = ""
            self.widget_process = None
            self.state.running = False
            self.state.status = "Widget exited"
        return asdict(self.state)

    def load_widget_config(self, path: str, params: dict[str, Any] | None = None) -> None:
        conf_path = os.path.join(self.workspace_root, path, "conf.json")
        with open(conf_path, "r", encoding="utf-8") as f:
            self.config = json.load(f)
        self.current_path = path
        self.current_params = params or {}
        app_id = self.config.get("id", "unknown_app")
        self.data_store_path = os.path.join(self.workspace_root, "user", "guest", app_id)
        os.makedirs(self.data_store_path, exist_ok=True)
        self.state.widgetPath = path
        raw_id = self.config.get("id")
        widget_id = str(raw_id).strip() if raw_id is not None else ""
        self.state.widgetId = widget_id or None
        self.state.widgetType = str(self.config.get("type", "game"))
        self.capture_base_name = sanitize_name(str(self.config.get("name", "capture")))
        self.state.status = f"Loaded config: {path}"

    def stop_widget_process(self) -> None:
        if self.widget_process is None:
            return
        if self.widget_process.poll() is None:
            self.widget_process.terminate()
            try:
                self.widget_process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.widget_process.kill()
                try:
                    self.widget_process.wait(timeout=2)
                except Exception:
                    pass
        self._stop_widget_log_readers()
        self.widget_process = None
        self.state.running = False
        self.state.status = "Widget stopped"

    def start_widget_process_for_current(self) -> None:
        if not self.current_path:
            raise ValueError("No widget path is configured")
        if self.config is None:
            self.load_widget_config(self.current_path, self.current_params)

        self.stop_widget_process()
        time.sleep(0.2)
        command = [
            sys.executable,
            os.path.join(self.workspace_root, self.current_path, "main.py"),
            "--params",
            json.dumps(self.current_params),
            "--shm",
            self.shm_pdi_name,
        ]
        if self.data_store_path:
            command.extend(["--data-store", self.data_store_path])

        child_env = os.environ.copy()
        child_env.setdefault("SDL_VIDEODRIVER", "dummy")
        child_env.setdefault("SDL_AUDIODRIVER", "dummy")
        child_env.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
        child_env.setdefault("PYTHONUNBUFFERED", "1")

        self.widget_process = subprocess.Popen(
            command,
            cwd=os.path.join(self.workspace_root, self.current_path),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=child_env,
        )
        self.state.running = True
        self.state.status = f"Widget running ({os.path.basename(sys.executable)})"
        self.state.lastError = None
        self._widget_stream_tail = ""
        self._start_widget_log_readers()

    def _pump_widget_stream(self, stream: Any, source: str) -> None:
        try:
            for line in iter(stream.readline, ""):
                if not line:
                    break
                text = line.rstrip("\r\n")
                if not text:
                    continue
                self._widget_log_queue.put(
                    {
                        "source": source,
                        "text": text,
                        "timestampMs": int(time.time() * 1000),
                    }
                )
                self._widget_stream_tail = (self._widget_stream_tail + "\n" + source + ": " + text)[-4000:]
        except Exception:
            pass

    def _start_widget_log_readers(self) -> None:
        self._stop_widget_log_readers(join_timeout=0.5)
        self._widget_log_queue = queue.Queue()
        proc = self.widget_process
        if proc is None:
            return
        threads: list[threading.Thread] = []
        if proc.stdout is not None:
            t = threading.Thread(target=self._pump_widget_stream, args=(proc.stdout, "stdout"), daemon=True)
            t.start()
            threads.append(t)
        if proc.stderr is not None:
            t = threading.Thread(target=self._pump_widget_stream, args=(proc.stderr, "stderr"), daemon=True)
            t.start()
            threads.append(t)
        self._log_reader_threads = threads

    def _stop_widget_log_readers(self, join_timeout: float = 2.0) -> None:
        for t in self._log_reader_threads:
            if t.is_alive():
                t.join(timeout=join_timeout)
        self._log_reader_threads = []

    def apply_command(self, command: dict[str, Any]) -> dict[str, Any]:
        action = command.get("type")
        try:
            if action == "set_path":
                path = command.get("path")
                if not isinstance(path, str):
                    raise ValueError("set_path requires string path")
                self.load_widget_config(path, self.current_params)
            elif action == "set_params":
                params = command.get("params")
                if not isinstance(params, dict):
                    raise ValueError("set_params requires object params")
                self.current_params = params
                self.state.status = "Params updated"
            elif action == "stop_widget":
                self.stop_widget_process()
                self.current_path = None
                self.current_params = {}
                self.config = None
                self.data_store_path = None
                self.state.widgetPath = None
                self.state.widgetId = None
                self.state.widgetType = None
                self.state.running = False
                self.state.lastError = None
                self.state.status = "Idle"
            elif action == "reload_widget":
                self.state.lastError = None
                self.start_widget_process_for_current()
            elif action == "capture_screenshot":
                filepath = self._capture_screenshot_png()
                self.state.status = f"Screenshot captured: {os.path.basename(filepath)}"
            elif action == "set_button":
                mapping = {
                    "A": 0x01,
                    "B": 0x02,
                    "UP": 0x04,
                    "RIGHT": 0x08,
                    "LEFT": 0x10,
                    "DOWN": 0x20,
                }
                button = str(command.get("button", "")).upper()
                if button not in mapping:
                    raise ValueError("Unknown button")
                pressed = bool(command.get("pressed", False))
                mask = mapping[button]
                if pressed:
                    self._button_state |= mask
                else:
                    self._button_state &= ~mask
                self._write_button_state()
                self.state.status = f"Button {button} {'down' if pressed else 'up'}"
            elif action == "throw_dart":
                index = int(command.get("index", 0))
                x = int(command.get("x", -1))
                y = int(command.get("y", -1))
                if index < 0 or index >= 12:
                    raise ValueError("Dart index out of range")
                self._darts[index] = [x, y]
                self._write_all_darts()
                self.state.status = f"Dart {index + 1} placed"
            elif action == "remove_dart_at":
                x = int(command.get("x", -1))
                y = int(command.get("y", -1))
                for i in range(12):
                    if self._darts[i] == [x, y]:
                        self._darts[i] = [-1, -1]
                        break
                self._write_all_darts()
                self.state.status = "Dart removed"
            elif action == "clear_darts":
                self._darts = [[-1, -1] for _ in range(12)]
                self._write_all_darts()
                self.state.status = "All darts cleared"
            else:
                raise ValueError(f"Unsupported command: {action}")
        except Exception as exc:
            self.state.lastError = str(exc)
            self.state.status = "Command failed"
        return self.snapshot()

    def _capture_screenshot_png(self) -> str:
        if self._last_frame_bytes is None:
            raise ValueError("No frame available yet for screenshot capture")
        frame_w = int(self._last_frame_w)
        frame_h = int(self._last_frame_h)
        if frame_w <= 0 or frame_h <= 0:
            raise ValueError("Invalid frame dimensions for screenshot capture")

        frame_img = Image.frombytes("RGB", (frame_w, frame_h), self._last_frame_bytes)
        canvas = self._build_capture_canvas(frame_img, frame_w, frame_h)

        capture_dir = os.path.join(self.workspace_root, "capture")
        os.makedirs(capture_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filename = f"{self.capture_base_name}_{timestamp}.png"
        filepath = os.path.join(capture_dir, filename)
        canvas.save(filepath, format="PNG")
        return filepath

    def _build_capture_canvas(self, frame_img: Image.Image, frame_w: int, frame_h: int) -> Image.Image:
        base_w, base_h = 588, 800
        main_x, main_y, main_w, main_h = 38, 38, 512, 512
        sec_x, sec_y, sec_w, sec_h = 123, 601, 342, 176
        bg_path = os.path.join(self.workspace_root, "PixelDarts.png")
        frame_img_rgba = frame_img.convert("RGBA")
        canvas = Image.new("RGBA", (base_w, base_h), (0, 0, 0, 255))
        draw = ImageDraw.Draw(canvas, "RGBA")
        draw.rectangle((main_x, main_y, main_x + main_w + 1, main_y + main_h + 1), fill=(0, 0, 0, 255))
        draw.rectangle((sec_x, sec_y, sec_x + sec_w + 1, sec_y + sec_h + 1), fill=(0, 0, 0, 255))

        if frame_w == 128 and frame_h == 160:
            main = frame_img_rgba.crop((0, 0, 128, 128)).resize((512, 512), Image.NEAREST)
            small = frame_img_rgba.crop((0, 128, 64, 160)).resize((342, 176), Image.NEAREST)
            canvas.paste(main, (main_x, main_y))
            canvas.paste(small, (sec_x, sec_y))
        elif frame_w == 128 and frame_h == 128:
            main = frame_img_rgba.resize((512, 512), Image.NEAREST)
            canvas.paste(main, (main_x, main_y))
        elif frame_w == 64 and frame_h == 32:
            small = frame_img_rgba.resize((342, 176), Image.NEAREST)
            canvas.paste(small, (sec_x, sec_y))
        else:
            main = frame_img_rgba.resize((512, 512), Image.NEAREST)
            canvas.paste(main, (main_x, main_y))
        self._draw_capture_grid_overlay(canvas, frame_w, frame_h)
        if os.path.exists(bg_path):
            frame_overlay = Image.open(bg_path).convert("RGBA").resize((base_w, base_h), Image.NEAREST)
            canvas.alpha_composite(frame_overlay)
        return canvas

    def _draw_capture_grid_overlay(self, canvas: Image.Image, frame_w: int, frame_h: int) -> None:
        overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay, "RGBA")
        grid_color = (0, 0, 0, 51)

        main_x, main_y = 38, 38
        main_step = 4
        main_size = 512
        for i in range(129):
            x = main_x + i * main_step
            y = main_y + i * main_step
            draw.rectangle((x, main_y, x, main_y + main_size - 1), fill=grid_color)
            draw.rectangle((main_x, y, main_x + main_size - 1, y), fill=grid_color)

        if (frame_w == 128 and frame_h == 160) or (frame_w == 64 and frame_h == 32):
            sec_x, sec_y = 123, 601
            sec_w, sec_h = 342, 176
            step_x = sec_w / 64
            step_y = sec_h / 32
            for i in range(65):
                x = round(sec_x + i * step_x)
                draw.rectangle((x, sec_y, x, sec_y + sec_h - 1), fill=grid_color)
            for i in range(33):
                y = round(sec_y + i * step_y)
                draw.rectangle((sec_x, y, sec_x + sec_w - 1, y), fill=grid_color)

        canvas.alpha_composite(overlay)

    def read_latest_frame(self) -> dict[str, Any] | None:
        if self.shm_pdi is None:
            return None
        width = 128
        height = 160
        if self.config and isinstance(self.config.get("size"), list) and len(self.config["size"]) == 2:
            width = int(self.config["size"][0])
            height = int(self.config["size"][1])
        total_bytes = width * height * 3
        if total_bytes <= 0:
            return None

        if self.shm_pdi.buf[0] != 0:
            return None
        frame = bytes(self.shm_pdi.buf[1 : 1 + total_bytes])
        self.shm_pdi.buf[0] = 1
        self._last_frame_bytes = frame
        self._last_frame_w = width
        self._last_frame_h = height

        return {
            "width": self._last_frame_w,
            "height": self._last_frame_h,
            "rgbBase64": base64.b64encode(self._last_frame_bytes).decode("ascii"),
            "timestampMs": int(time.time() * 1000),
        }

    def poll_widget_logs(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        if self._pending_widget_logs:
            result.extend(self._pending_widget_logs)
            self._pending_widget_logs = []
        while True:
            try:
                result.append(self._widget_log_queue.get_nowait())
            except queue.Empty:
                break
        return result

    def shutdown(self) -> None:
        self.stop_widget_process()
        if self.shm_pdo is not None:
            try:
                self.shm_pdo.close()
                self.shm_pdo.unlink()
            except FileNotFoundError:
                pass
            self.shm_pdo = None
        if self.shm_pdi is not None:
            try:
                self.shm_pdi.close()
                self.shm_pdi.unlink()
            except FileNotFoundError:
                pass
            self.shm_pdi = None
