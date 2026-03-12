import sys
from multiprocessing import shared_memory
import subprocess
import os
import numpy as np
import json
import argparse
import tempfile
import time
from datetime import datetime
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog
from PIL import Image, ImageTk

# Constants
SCALE_FACTOR = 4
BORDER_WIDTH = 0
SMALL_SCALE_X = 5.5
SMALL_SCALE_Y = 5.3
DART_OFFSET = [38, 38]
DART_COORD_OFFSET = 1800
DART_COORD_SCALE = 299
FPS = 60
DOUBLE_CLICK_THRESHOLD = 500
WINDOW_WIDTH = 588
WINDOW_HEIGHT = 800

# Button masks
BUTTON_A = 0x01
BUTTON_B = 0x02
BUTTON_LEFT = 0x10
BUTTON_UP = 0x04
BUTTON_RIGHT = 0x08
BUTTON_DOWN = 0x20

# Shared memory names
SHM_PDI_NAME = "shmpdi"
SHM_PDO_NAME = "pdoshm"

STATE_FILENAME = ".emulator_last.json"


def _state_file_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), STATE_FILENAME)


def load_last_opened():
    """Return (path, params_str) or (None, '{}') from saved state."""
    try:
        with open(_state_file_path()) as f:
            data = json.load(f)
        path = data.get("path")
        params = data.get("params", "{}")
        if path and os.path.isdir(path):
            return path, params
    except (OSError, json.JSONDecodeError):
        pass
    return None, "{}"


def save_last_opened(path, params_str):
    """Persist path and params for use as defaults next time."""
    try:
        with open(_state_file_path(), "w") as f:
            json.dump({"path": path, "params": params_str}, f)
    except OSError:
        pass


parser = argparse.ArgumentParser(description="Dartsnut")
parser.add_argument(
    "--params", type=str, default="{}", help="JSON string for program parameters"
)
parser.add_argument(
    "--path", type=str, default=None, help="the path of your program (widget/game), relative (optional)"
)
args = parser.parse_args()


def cleanup_shared_memory(name):
    """Remove existing shared memory if it exists."""
    try:
        existing_shm = shared_memory.SharedMemory(name=name)
        existing_shm.close()
        existing_shm.unlink()
    except FileNotFoundError:
        pass
    except FileExistsError:
        shared_memory.SharedMemory(name=name).unlink()


def sanitize_name(name: str) -> str:
    """Sanitize widget/game name for safe filesystem use."""
    if not name:
        return "capture"
    invalid_chars = '<>:"/\\|?*'
    sanitized = "".join("_" if c in invalid_chars else c for c in name)
    sanitized = "_".join(sanitized.split())
    return sanitized or "capture"


def scale_pixel_with_border(out_frame, frame, x, y, x_start, y_start, scale, border):
    """Scale a single pixel with border into the output frame."""
    if border > 0:
        out_frame[y_start : y_start + scale, x_start : x_start + scale] = [0, 0, 0]
        out_frame[
            y_start + border : y_start + scale - border,
            x_start + border : x_start + scale - border,
        ] = frame[y, x]
    else:
        out_frame[y_start : y_start + scale, x_start : x_start + scale] = frame[y, x]


def render_frame_optimized(frame, widget_size, out_frame_main, out_frame_small):
    """Optimized frame rendering with reduced calculations."""
    height, width = widget_size[1], widget_size[0]

    if widget_size == [128, 160]:
        for y in range(128):
            y_start = y * SCALE_FACTOR
            for x in range(128):
                x_start = x * SCALE_FACTOR
                scale_pixel_with_border(
                    out_frame_main,
                    frame,
                    x,
                    y,
                    x_start,
                    y_start,
                    SCALE_FACTOR,
                    BORDER_WIDTH,
                )
        for y in range(128, 160):
            y_start = int((y - 128) * SMALL_SCALE_Y)
            for x in range(64):
                x_start = int(x * SMALL_SCALE_X)
                scale_pixel_with_border(
                    out_frame_small,
                    frame,
                    x,
                    y,
                    x_start,
                    y_start,
                    SCALE_FACTOR,
                    BORDER_WIDTH,
                )
    elif widget_size == [64, 32]:
        for y in range(32):
            y_start = int(y * SMALL_SCALE_Y)
            for x in range(64):
                x_start = int(x * SMALL_SCALE_X)
                scale_pixel_with_border(
                    out_frame_small,
                    frame,
                    x,
                    y,
                    x_start,
                    y_start,
                    SCALE_FACTOR,
                    BORDER_WIDTH,
                )
    else:
        for y in range(height):
            y_start = y * SCALE_FACTOR
            for x in range(width):
                x_start = x * SCALE_FACTOR
                scale_pixel_with_border(
                    out_frame_main,
                    frame,
                    x,
                    y,
                    x_start,
                    y_start,
                    SCALE_FACTOR,
                    BORDER_WIDTH,
                )
    return out_frame_main, out_frame_small


def draw_capture_grid(region, x_positions, y_positions):
    """Draw a 1px grid with 50% black over a scaled region (numpy array HxWx3 RGB)."""
    h, w = region.shape[0], region.shape[1]
    mask = np.zeros((h, w), dtype=bool)
    for y in y_positions:
        if 0 <= y < h:
            mask[y, :] = True
    for x in x_positions:
        if 0 <= x < w:
            mask[:, x] = True
    region[mask] = (region[mask].astype(np.float64) * 0.5).astype(np.uint8)


def get_capture_region(frame, widget_size, capture_main):
    """Return the raw borderless region to capture based on widget size."""
    if frame is None:
        return None
    if widget_size == [128, 128]:
        return frame
    elif widget_size == [128, 160]:
        if capture_main:
            return frame[0:128, 0:128]
        else:
            return frame[128:160, 0:128]
    else:
        return frame


def capture_screenshot_pil(frame, widget_size, capture_main_surface, capture_base_name, script_dir):
    """Capture and save a screenshot using PIL."""
    region = get_capture_region(frame, widget_size, capture_main_surface)
    if region is None:
        return
    h, w = region.shape[0], region.shape[1]
    if (h, w) == (128, 128):
        scaled = np.zeros((128 * SCALE_FACTOR, 128 * SCALE_FACTOR, 3), dtype=np.uint8)
        for y in range(128):
            y_start = y * SCALE_FACTOR
            for x in range(128):
                x_start = x * SCALE_FACTOR
                scaled[y_start : y_start + SCALE_FACTOR, x_start : x_start + SCALE_FACTOR] = region[y, x]
        draw_capture_grid(scaled, [4 * i for i in range(1, 128)], [4 * i for i in range(1, 128)])
        scaled_rotated = np.fliplr(np.rot90(scaled, k=-1))
        pil_img = Image.fromarray(np.transpose(scaled_rotated, (1, 0, 2)), mode="RGB")
    elif (h, w) == (32, 64):
        scaled = np.zeros((176, 342, 3), dtype=np.uint8)
        for y in range(32):
            y_start = int(y * SMALL_SCALE_Y)
            for x in range(64):
                x_start = int(x * SMALL_SCALE_X)
                scaled[y_start : y_start + SCALE_FACTOR, x_start : x_start + SCALE_FACTOR] = region[y, x]
        draw_capture_grid(
            scaled,
            [int(i * SMALL_SCALE_X) for i in range(1, 64)],
            [int(i * SMALL_SCALE_Y) for i in range(1, 32)],
        )
        scaled_rotated = np.fliplr(np.rot90(scaled, k=-1))
        pil_img = Image.fromarray(np.transpose(scaled_rotated, (1, 0, 2)), mode="RGB")
    else:
        pil_img = Image.fromarray(np.transpose(region, (1, 0, 2)), mode="RGB")

    capture_dir = os.path.join(script_dir, "capture")
    os.makedirs(capture_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"{capture_base_name}_{timestamp}.png"
    filepath = os.path.join(capture_dir, filename)
    pil_img.save(filepath)


def capture_borderless_screenshot_pil(frame, capture_base_name, script_dir, background_pil):
    """Capture and save a borderless screenshot for 128x160 widgets with device frame."""
    if frame is None:
        return
    main_region = frame[0:128, 0:128]
    small_region = frame[128:160, 0:64]

    main_scaled = np.zeros((128 * SCALE_FACTOR, 128 * SCALE_FACTOR, 3), dtype=np.uint8)
    for y in range(128):
        y_start = y * SCALE_FACTOR
        for x in range(128):
            x_start = x * SCALE_FACTOR
            main_scaled[
                y_start : y_start + SCALE_FACTOR, x_start : x_start + SCALE_FACTOR
            ] = main_region[y, x]
    draw_capture_grid(
        main_scaled,
        [4 * i for i in range(1, 128)],
        [4 * i for i in range(1, 128)],
    )

    small_scaled = np.zeros((176, 342, 3), dtype=np.uint8)
    for y in range(32):
        y_start = int(y * SMALL_SCALE_Y)
        for x in range(64):
            x_start = int(x * SMALL_SCALE_X)
            pixel = small_region[y, x]
            small_scaled[
                y_start : y_start + SCALE_FACTOR, x_start : x_start + SCALE_FACTOR
            ] = pixel
    draw_capture_grid(
        small_scaled,
        [int(i * SMALL_SCALE_X) for i in range(1, 64)],
        [int(i * SMALL_SCALE_Y) for i in range(1, 32)],
    )

    screenshot_img = background_pil.copy()
    main_rotated = np.fliplr(np.rot90(main_scaled, k=-1))
    main_pil = Image.fromarray(np.transpose(main_rotated, (1, 0, 2)), mode="RGB")
    small_rotated = np.fliplr(np.rot90(small_scaled, k=-1))
    small_pil = Image.fromarray(np.transpose(small_rotated, (1, 0, 2)), mode="RGB")
    screenshot_img.paste(main_pil, (38, 38))
    screenshot_img.paste(small_pil, (125, 603))

    capture_dir = os.path.join(script_dir, "capture")
    os.makedirs(capture_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"{capture_base_name}_{timestamp}.png"
    filepath = os.path.join(capture_dir, filename)
    screenshot_img.save(filepath)


def coords_to_dart_position(mouse_x, mouse_y):
    """Convert mouse coordinates to raw dart coordinates written to `pdoshm`.

    Note: pydartsnut reads raw coordinates in the hardware space (1800..39800)
    and maps them back to 0..127 internally.

    The main display is shown rotated 90° CW and flipped horizontally.
    """
    dx = (mouse_x - DART_OFFSET[0]) // SCALE_FACTOR
    dy = (mouse_y - DART_OFFSET[1]) // SCALE_FACTOR
    # Current main-surface rendering transforms cancel out due to an extra transpose
    # on conversion to PIL, so the display coordinates map 1:1 to buffer coordinates.
    buf_x = dx
    buf_y = dy
    buf_x = min(127, max(0, int(buf_x)))
    buf_y = min(127, max(0, int(buf_y)))
    raw_x = DART_COORD_OFFSET + buf_x * DART_COORD_SCALE
    raw_y = DART_COORD_OFFSET + buf_y * DART_COORD_SCALE
    return raw_x, raw_y


def is_within_dart_area(mouse_x, mouse_y):
    """Check if mouse position is within the dart area."""
    return (
        DART_OFFSET[0] <= mouse_x <= 128 * SCALE_FACTOR + DART_OFFSET[0]
        and DART_OFFSET[1] <= mouse_y <= 128 * SCALE_FACTOR + DART_OFFSET[1]
    )


def update_darts_in_shared_memory(shm_pdo, darts, previous_darts):
    """Update dart positions in shared memory only if changed."""
    for i in range(12):
        if darts[i] != previous_darts[i]:
            if darts[i][0] == -1 and darts[i][1] == -1:
                shm_pdo.buf[i * 4 + 1 : i * 4 + 3] = (0xFFFF).to_bytes(2, "little")
                shm_pdo.buf[i * 4 + 3 : i * 4 + 5] = (0xFFFF).to_bytes(2, "little")
            else:
                # pydartsnut expects raw hardware-space coordinates (~1800..39800)
                x_val = min(39800, max(0, int(darts[i][0])))
                y_val = min(39800, max(0, int(darts[i][1])))
                shm_pdo.buf[i * 4 + 1 : i * 4 + 3] = (x_val).to_bytes(2, "little")
                shm_pdo.buf[i * 4 + 3 : i * 4 + 5] = (y_val).to_bytes(2, "little")
            previous_darts[i] = darts[i][:]


def get_button_state_from_set(pressed_keys):
    """Get current button state from set of pressed key symbols."""
    button = 0
    if "k" in pressed_keys:
        button |= BUTTON_A
    if "l" in pressed_keys:
        button |= BUTTON_B
    if "a" in pressed_keys:
        button |= BUTTON_LEFT
    if "w" in pressed_keys:
        button |= BUTTON_UP
    if "d" in pressed_keys:
        button |= BUTTON_RIGHT
    if "s" in pressed_keys:
        button |= BUTTON_DOWN
    return button


class EmulatorApp:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("Dartsnut Emulator")
        self.root.minsize(WINDOW_WIDTH, WINDOW_HEIGHT)
        self.root.resizable(False, False)

        script_dir = os.path.dirname(os.path.abspath(__file__))
        bg_path = os.path.join(script_dir, "PixelDarts.png")
        if not os.path.exists(bg_path):
            bg_path = "PixelDarts.png"
        self.background_pil = Image.open(bg_path).convert("RGB")
        self.background_photo = ImageTk.PhotoImage(self.background_pil)

        self.canvas = tk.Canvas(
            self.root, width=WINDOW_WIDTH, height=WINDOW_HEIGHT, highlightthickness=0
        )
        self.canvas.pack()
        self.canvas.create_image(0, 0, anchor=tk.NW, image=self.background_photo)
        self.current_frame_photo = None
        self.current_frame_id = None

        # Program state (None when no program loaded)
        self.current_path = None
        self.current_params_str = "{}"
        self.process = None
        self.shm_pdi = None
        self.shm_pdo = None
        self.config = None
        self.widget_size = None
        self.params = None
        self.command = None
        self.data_store_path = None
        self.capture_main_surface = False
        self.capture_base_name = "capture"
        self.out_frame_main = np.zeros((128 * SCALE_FACTOR, 128 * SCALE_FACTOR, 3), dtype=np.uint8)
        self.out_frame_small = np.zeros((176, 342, 3), dtype=np.uint8)
        self.last_frame = None
        self.darts = [[-1, -1] for _ in range(12)]
        self.previous_darts = [[-1, -1] for _ in range(12)]
        self.previous_button_state = 0
        self.last_right_click = 0
        self.pressed_keys = set()
        self.mouse_x = 0
        self.mouse_y = 0

        self._last_path, self._last_params_str = load_last_opened()

        self._build_menu()
        self._bind_events()

        if args.path:
            self.root.after(0, lambda: self.load_widget(args.path, args.params))
        else:
            self._show_placeholder()

        self.tick()

    def _build_menu(self):
        menubar = tk.Menu(self.root)
        self.root.config(menu=menubar)

        file_menu = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label="File", menu=file_menu)
        file_menu.add_command(label="Open program…", command=self.menu_open_widget, accelerator="Ctrl+O")
        self.screenshot_var = tk.BooleanVar(value=False)
        self.restart_var = tk.BooleanVar(value=False)
        file_menu.add_command(
            label="Screenshot",
            command=self.menu_screenshot,
            state=tk.DISABLED,
            accelerator="P",
        )
        file_menu.add_separator()
        file_menu.add_command(label="Exit", command=self.menu_exit, accelerator="Ctrl+Q")

        widget_menu = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label="Program", menu=widget_menu)
        widget_menu.add_command(
            label="Restart",
            command=self.menu_restart,
            state=tk.DISABLED,
            accelerator="R",
        )
        self._file_menu = file_menu
        self._widget_menu = widget_menu

        self.root.bind("<Control-o>", lambda e: self.menu_open_widget())
        self.root.bind("<Control-q>", lambda e: self.menu_exit())

    def _set_widget_menu_state(self, enabled):
        state = tk.NORMAL if enabled else tk.DISABLED
        try:
            self._file_menu.entryconfig(2, state=state)
            self._widget_menu.entryconfig(0, state=state)
        except tk.TclError:
            # macOS native menus may not support -state for menu entries
            pass

    def _show_placeholder(self):
        self.canvas.delete("placeholder")
        self.canvas.create_text(
            WINDOW_WIDTH // 2,
            WINDOW_HEIGHT // 2,
            text="File → Open program to load",
            fill="gray",
            font=("TkDefaultFont", 14),
            tags="placeholder",
        )

    def _clear_placeholder(self):
        self.canvas.delete("placeholder")

    def _validate_widget_path(self, path):
        if not path or not os.path.isdir(path):
            return False
        conf_path = os.path.join(path, "conf.json")
        main_path = os.path.join(path, "main.py")
        return os.path.isfile(conf_path) and os.path.isfile(main_path)

    def _unload_widget(self):
        """Clean up current program: process and shared memory."""
        if self.process is not None:
            try:
                if self.process.poll() is None:
                    self.process.terminate()
                    try:
                        self.process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        self.process.kill()
            except Exception:
                pass
            self.process = None
        if self.shm_pdo is not None:
            try:
                self.shm_pdo.close()
                self.shm_pdo.unlink()
            except Exception:
                pass
            self.shm_pdo = None
        if self.shm_pdi is not None:
            try:
                self.shm_pdi.close()
                self.shm_pdi.unlink()
            except Exception:
                pass
            self.shm_pdi = None
        self.current_path = None
        self.config = None
        self.widget_size = None
        self.params = None
        self.command = None
        self.last_frame = None
        self.darts = [[-1, -1] for _ in range(12)]
        self.previous_darts = [[-1, -1] for _ in range(12)]
        self.previous_button_state = 0
        if self.current_frame_id is not None:
            self.canvas.delete(self.current_frame_id)
            self.current_frame_id = None
        self.current_frame_photo = None
        self._set_widget_menu_state(False)
        self.root.title("Dartsnut Emulator")
        self._show_placeholder()

    def load_widget(self, path, params_str="{}"):
        """Load a program (widget or game) from path with optional params JSON string."""
        path = os.path.normpath(path)
        if not os.path.isabs(path):
            path = os.path.join(os.getcwd(), path)
        if not self._validate_widget_path(path):
            messagebox.showerror("Invalid program", "Path must be a directory containing conf.json and main.py")
            return
        try:
            params = json.loads(params_str)
        except json.JSONDecodeError:
            messagebox.showerror("Invalid params", "Params must be valid JSON (e.g. {})")
            return

        self._unload_widget()

        cleanup_shared_memory(SHM_PDI_NAME)
        cleanup_shared_memory(SHM_PDO_NAME)
        self.shm_pdi = shared_memory.SharedMemory(
            name=SHM_PDI_NAME, create=True, size=128 * 160 * 3 + 1
        )
        self.shm_pdo = shared_memory.SharedMemory(
            name=SHM_PDO_NAME, create=True, size=49
        )
        # Initialize dart coordinates to invalid (0xFFFF) for all 12 darts so
        # pydartsnut sees a clean invalid->valid transition on the first hit.
        self.shm_pdo.buf[0] = 0  # buttons
        for i in range(12):
            off = 1 + i * 4
            self.shm_pdo.buf[off : off + 2] = (0xFFFF).to_bytes(2, "little")
            self.shm_pdo.buf[off + 2 : off + 4] = (0xFFFF).to_bytes(2, "little")

        with open(os.path.join(path, "conf.json")) as f:
            self.config = json.load(f)
        self.widget_size = self.config.get("size", [128, 160])
        app_id = self.config.get("id", "")
        self.params = params
        self.current_path = path
        self.current_params_str = params_str
        self.capture_main_surface = self.widget_size in ([128, 128], [128, 160])
        self.capture_base_name = sanitize_name(self.config.get("name", "capture"))

        for param in self.config["fields"]:
            if param["type"] == "image" and param["id"] in self.params:
                image = self.params[param["id"]]
                image_path = image["image"]
                cropbox = image["cropbox"]
                src_path = os.path.join(path, image_path)
                with open(src_path, "rb") as src_file:
                    temp_file = tempfile.NamedTemporaryFile(
                        delete=False, suffix=os.path.splitext(image_path)[1]
                    )
                    temp_file.write(src_file.read())
                    temp_file.close()
                self.params[param["id"]] = {"image": temp_file.name, "cropbox": cropbox}

        script_dir = os.path.dirname(os.path.abspath(__file__))
        self.data_store_path = os.path.join(script_dir, "user", "guest", app_id)
        os.makedirs(self.data_store_path, exist_ok=True)

        cwd_for_process = path if os.path.isdir(path) else os.getcwd()
        main_py = os.path.join(path, "main.py")
        self.command = [
            sys.executable,
            main_py,
            "--params", json.dumps(self.params),
            "--shm", SHM_PDI_NAME,
            "--data-store", self.data_store_path,
        ]

        def start_process():
            time.sleep(0.5)
            return subprocess.Popen(
                self.command,
                cwd=cwd_for_process,
                stdout=sys.stdout,
                stderr=sys.stderr,
            )

        self.process = start_process()
        self._clear_placeholder()
        self._set_widget_menu_state(True)
        self.root.title("Dartsnut Emulator - " + self.config.get("name", "Unknown program"))

        save_last_opened(path, params_str)
        self._last_path = path
        self._last_params_str = params_str

    def menu_open_widget(self):
        initialdir = self._last_path if self._last_path and os.path.isdir(self._last_path) else os.getcwd()
        path = filedialog.askdirectory(
            title="Select program directory (containing conf.json and main.py)",
            initialdir=initialdir,
        )
        if not path:
            return
        params_str = simpledialog.askstring(
            "Program params",
            "Params (JSON string):",
            initialvalue=self._last_params_str,
        )
        if params_str is None:
            return
        if not params_str.strip():
            params_str = "{}"
        self.load_widget(path, params_str)

    def menu_restart(self):
        if self.process is None or self.command is None:
            return
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
        cwd = self.current_path if os.path.isdir(self.current_path) else os.getcwd()
        time.sleep(0.5)
        self.process = subprocess.Popen(
            self.command,
            cwd=cwd,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )

    def menu_screenshot(self):
        if self.last_frame is None or self.widget_size is None:
            return
        script_dir = os.path.dirname(os.path.abspath(__file__))
        if self.widget_size == [128, 160]:
            capture_borderless_screenshot_pil(
                self.last_frame,
                self.capture_base_name,
                script_dir,
                self.background_pil,
            )
        else:
            capture_screenshot_pil(
                self.last_frame,
                self.widget_size,
                self.capture_main_surface,
                self.capture_base_name,
                script_dir,
            )

    def menu_exit(self):
        self._unload_widget()
        self.root.quit()

    def _bind_events(self):
        self.root.bind_all("<KeyPress>", self._on_key_down)
        self.root.bind_all("<KeyRelease>", self._on_key_up)
        self.canvas.bind("<Button-1>", self._on_left_click)
        self.canvas.bind("<B1-Motion>", self._on_left_drag)
        # Right-click: varies by platform / mouse config.
        self.canvas.bind("<Button-3>", self._on_right_click)          # common
        self.canvas.bind("<Button-2>", self._on_right_click)          # some macOS setups
        self.canvas.bind("<Control-Button-1>", self._on_right_click)  # macOS ctrl-click
        self.canvas.bind("<Motion>", self._on_motion)
        self.root.protocol("WM_DELETE_WINDOW", self.menu_exit)

    def _on_key_down(self, event):
        sym = event.keysym.lower() if event.keysym else ""
        self.pressed_keys.add(sym)
        if sym == "r" and self.process is not None:
            self.menu_restart()
        elif sym == "p" and self.last_frame is not None:
            self.menu_screenshot()

    def _on_key_up(self, event):
        sym = event.keysym.lower() if event.keysym else ""
        self.pressed_keys.discard(sym)

    def _on_motion(self, event):
        self.mouse_x = event.x
        self.mouse_y = event.y

    def _place_dart_at(self, x_canvas, y_canvas):
        inside = is_within_dart_area(x_canvas, y_canvas)
        if self.process is None or not inside:
            return
        x, y = coords_to_dart_position(x_canvas, y_canvas)
        dart_index = 0
        for i in range(12):
            if f"f{i + 1}" in self.pressed_keys:
                dart_index = i
                break
        self.darts[dart_index] = [x, y]

    def _on_left_click(self, event):
        self.mouse_x, self.mouse_y = event.x, event.y
        self._place_dart_at(event.x, event.y)

    def _on_left_drag(self, event):
        self.mouse_x, self.mouse_y = event.x, event.y
        self._place_dart_at(event.x, event.y)

    def _on_right_click(self, event):
        self.mouse_x, self.mouse_y = event.x, event.y
        if self.process is None:
            return
        now = int(time.time() * 1000)
        if now - self.last_right_click < DOUBLE_CLICK_THRESHOLD:
            self.darts = [[-1, -1] for _ in range(12)]
        else:
            self.last_right_click = now
        if is_within_dart_area(event.x, event.y):
            x, y = coords_to_dart_position(event.x, event.y)
            for i in range(12):
                if self.darts[i] == [x, y]:
                    self.darts[i] = [-1, -1]
                    break

    def tick(self):
        if self.shm_pdi is not None and self.shm_pdo is not None and self.widget_size is not None:
            if self.shm_pdi.buf[0] == 0:
                frame = np.frombuffer(
                    self.shm_pdi.buf[1 : self.widget_size[0] * self.widget_size[1] * 3 + 1],
                    dtype=np.uint8,
                )
                frame = frame.reshape((self.widget_size[1], self.widget_size[0], 3))
                self.last_frame = frame.copy()
                self.out_frame_main, self.out_frame_small = render_frame_optimized(
                    frame,
                    self.widget_size,
                    self.out_frame_main,
                    self.out_frame_small,
                )
                main_rotated = np.fliplr(np.rot90(self.out_frame_main, k=-1))
                main_pil = Image.fromarray(
                    np.transpose(main_rotated, (1, 0, 2)), mode="RGB"
                )
                small_rotated = np.fliplr(np.rot90(self.out_frame_small, k=-1))
                small_pil = Image.fromarray(
                    np.transpose(small_rotated, (1, 0, 2)), mode="RGB"
                )
                composite = self.background_pil.copy()
                composite.paste(main_pil, (38, 38))
                composite.paste(small_pil, (125, 603))
                self.current_frame_photo = ImageTk.PhotoImage(composite)
                if self.current_frame_id is not None:
                    self.canvas.delete(self.current_frame_id)
                self.current_frame_id = self.canvas.create_image(
                    0, 0, anchor=tk.NW, image=self.current_frame_photo
                )
                self.shm_pdi.buf[0] = 1

            button = get_button_state_from_set(self.pressed_keys)
            if button != self.previous_button_state:
                self.shm_pdo.buf[0] = button
                self.previous_button_state = button

            _darts_changed = self.darts != self.previous_darts
            if _darts_changed:
                update_darts_in_shared_memory(
                    self.shm_pdo, self.darts, self.previous_darts
                )

        self.root.after(round(1000 / FPS), self.tick)

    def run(self):
        self.root.mainloop()


def main():
    app = EmulatorApp()
    app.run()


if __name__ == "__main__":
    main()
