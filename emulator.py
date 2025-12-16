import sys
from multiprocessing import shared_memory
import subprocess
import os
import numpy as np
import pygame
import json
import argparse
import tempfile
from datetime import datetime

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

# Button masks
BUTTON_A = 0x01
BUTTON_B = 0x02
BUTTON_LEFT = 0x10
BUTTON_UP = 0x04
BUTTON_RIGHT = 0x08
BUTTON_DOWN = 0x20

parser = argparse.ArgumentParser(description="Dartsnut")
parser.add_argument(
    "--params",
    type=str,
    default="{}",
    help="JSON string for widget parameters"
)
parser.add_argument(
    "--path",
    type=str,
    required=True,
    help="the path of your widget, relative"
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

# Initialize shared memory for display
shm_pdi_name = "shmpdi"
cleanup_shared_memory(shm_pdi_name)
shm_pdi = shared_memory.SharedMemory(name=shm_pdi_name, create=True, size=128*160*3+1)

# Initialize shared memory for darts and buttons
shm_pdo_name = "pdoshm"
cleanup_shared_memory(shm_pdo_name)
shm_pdo = shared_memory.SharedMemory(name=shm_pdo_name, create=True, size=49)  # 12 darts, each with x and y coordinates

# read the conf.json at args.path/conf.json to get the display mode
with open(os.path.join(os.getcwd(), args.path, "conf.json")) as f:
    config = json.load(f)
params = json.loads(args.params)

widget_size = config.get("size", [128, 160])


def sanitize_name(name: str) -> str:
    """Sanitize widget/game name for safe filesystem use."""
    if not name:
        return "capture"
    # Replace problematic characters with underscore
    invalid_chars = '<>:"/\\|?*'
    sanitized = "".join("_" if c in invalid_chars else c for c in name)
    # Collapse whitespace into single underscores
    sanitized = "_".join(sanitized.split())
    return sanitized or "capture"


# Decide whether screenshots should capture the main (game/128 widget) or secondary surface
capture_main_surface = widget_size in ([128, 128], [128, 160])
capture_base_name = sanitize_name(config.get("name", "capture"))

for param in config["fields"]:
    if param["type"] == "image":
        # if the param is of type image, and the params has it, convert the list to absolute path
        if param["id"] in params:
            image = params[param["id"]]
            image_path = image["image"]
            cropbox = image["cropbox"]
            with open(os.path.join(os.getcwd(), args.path, image_path), "rb") as src_file:
                temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(image_path)[1])
                temp_file.write(src_file.read())
                temp_file.close()
                params[param["id"]] = {
                    "image": temp_file.name,
                    "cropbox": cropbox
                }

# start the process
command = [sys.executable, os.path.join(os.getcwd(), args.path, "main.py")]
command.extend(["--params", json.dumps(params)])
command.extend(["--shm", shm_pdi_name])


def start_widget_process():
    """Launch the widget subprocess."""
    return subprocess.Popen(
        command,
        cwd=args.path,
    )


process = start_widget_process()

# Initialize Pygame
pygame.init()

screen = pygame.display.set_mode((588, 800))
background = pygame.image.load("PixelDarts.png")
pygame.display.set_caption("Dartsnut Emulator - " + config.get("name", "Unknown Widget"))
clock = pygame.time.Clock()
running = True
last_right_click = 0

# Initialize darts tracking
darts = [[-1, -1] for _ in range(12)]
previous_button_state = 0
previous_darts = [[-1, -1] for _ in range(12)]

# Pre-allocate frame buffers to avoid repeated allocations
out_frame_main = np.zeros((128 * SCALE_FACTOR, 128 * SCALE_FACTOR, 3), dtype=np.uint8)
out_frame_small = np.zeros((176, 342, 3), dtype=np.uint8)

# Keep track of the last rendered raw frame for screenshots
last_frame = None


def scale_pixel_with_border(out_frame, frame, x, y, x_start, y_start, scale, border):
    """Scale a single pixel with border into the output frame."""
    if border > 0:
        out_frame[y_start:y_start+scale, x_start:x_start+scale] = [0, 0, 0]
        out_frame[y_start+border:y_start+scale-border, x_start+border:x_start+scale-border] = frame[y, x]
    else:
        out_frame[y_start:y_start+scale, x_start:x_start+scale] = frame[y, x]


def render_frame_optimized(frame, widget_size, out_frame_main, out_frame_small):
    """Optimized frame rendering with reduced calculations."""
    height, width = widget_size[1], widget_size[0]
    
    if widget_size == [128, 160]:
        # Main display (128x128)
        for y in range(128):
            y_start = y * SCALE_FACTOR
            for x in range(128):
                x_start = x * SCALE_FACTOR
                scale_pixel_with_border(out_frame_main, frame, x, y, x_start, y_start, SCALE_FACTOR, BORDER_WIDTH)
        
        # Small display (128-160 rows, 64 columns)
        for y in range(128, 160):
            y_start = int((y-128) * SMALL_SCALE_Y)
            for x in range(64):
                x_start = int(x * SMALL_SCALE_X)
                scale_pixel_with_border(out_frame_small, frame, x, y, x_start, y_start, SCALE_FACTOR, BORDER_WIDTH)
    
    elif widget_size == [64, 32]:
        # Small display only
        for y in range(32):
            y_start = int(y * SMALL_SCALE_Y)
            for x in range(64):
                x_start = int(x * SMALL_SCALE_X)
                scale_pixel_with_border(out_frame_small, frame, x, y, x_start, y_start, SCALE_FACTOR, BORDER_WIDTH)
    
    else:
        # Standard display
        for y in range(height):
            y_start = y * SCALE_FACTOR
            for x in range(width):
                x_start = x * SCALE_FACTOR
                scale_pixel_with_border(out_frame_main, frame, x, y, x_start, y_start, SCALE_FACTOR, BORDER_WIDTH)
    
    return out_frame_main, out_frame_small


def get_capture_region(frame, widget_size, capture_main):
    """
    Return the raw borderless region to capture based on widget size.

    - [128,128]: main is full frame.
    - [128,160]: main is top 128x128; secondary is bottom 32x128.
    - other sizes (e.g. [64,32]): entire frame is treated as secondary.
    """
    height, width = widget_size[1], widget_size[0]

    # Safety check
    if frame is None:
        return None

    if widget_size == [128, 128]:
        # Only main display exists; capture full frame
        return frame
    elif widget_size == [128, 160]:
        if capture_main:
            # Top 128x128
            return frame[0:128, 0:128]
        else:
            # Bottom 32x128
            return frame[128:160, 0:128]
    else:
        # Other sizes: entire frame is considered secondary
        return frame


def capture_screenshot(frame):
    """Capture and save a screenshot of the appropriate display region."""
    global capture_main_surface, capture_base_name

    region = get_capture_region(frame, widget_size, capture_main_surface)
    if region is None:
        return

    # Convert region to a Pygame surface (width x height x 3 -> transpose for surfarray)
    surface = pygame.surfarray.make_surface(np.transpose(region, (1, 0, 2)))

    # Ensure capture directory exists next to emulator.py
    script_dir = os.path.dirname(os.path.abspath(__file__))
    capture_dir = os.path.join(script_dir, "capture")
    os.makedirs(capture_dir, exist_ok=True)

    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = f"{capture_base_name}_{timestamp}.png"
    filepath = os.path.join(capture_dir, filename)

    pygame.image.save(surface, filepath)


def get_button_state(keys):
    """Get current button state from keyboard input."""
    button = 0
    if keys[pygame.K_k]:
        button |= BUTTON_A
    if keys[pygame.K_l]:
        button |= BUTTON_B
    if keys[pygame.K_a]:
        button |= BUTTON_LEFT
    if keys[pygame.K_w]:
        button |= BUTTON_UP
    if keys[pygame.K_d]:
        button |= BUTTON_RIGHT
    if keys[pygame.K_s]:
        button |= BUTTON_DOWN
    return button


def coords_to_dart_position(mouse_x, mouse_y):
    """Convert mouse coordinates to dart position."""
    x = (mouse_x - DART_OFFSET[0]) // SCALE_FACTOR * DART_COORD_SCALE + DART_COORD_OFFSET
    y = (mouse_y - DART_OFFSET[1]) // SCALE_FACTOR * DART_COORD_SCALE + DART_COORD_OFFSET
    return x, y


def is_within_dart_area(mouse_x, mouse_y):
    """Check if mouse position is within the dart area."""
    return (DART_OFFSET[0] <= mouse_x <= 128*SCALE_FACTOR + DART_OFFSET[0] and 
            DART_OFFSET[1] <= mouse_y <= 128*SCALE_FACTOR + DART_OFFSET[1])


def update_darts_in_shared_memory(shm_pdo, darts, previous_darts):
    """Update dart positions in shared memory only if changed."""
    for i in range(12):
        if darts[i] != previous_darts[i]:
            if darts[i][0] == -1 and darts[i][1] == -1:
                shm_pdo.buf[i*4+1:i*4+3] = (0xffff).to_bytes(2, 'little')
                shm_pdo.buf[i*4+3:i*4+5] = (0xffff).to_bytes(2, 'little')
            else:
                shm_pdo.buf[i*4+1:i*4+3] = (darts[i][0]).to_bytes(2, 'little')
                shm_pdo.buf[i*4+3:i*4+5] = (darts[i][1]).to_bytes(2, 'little')
            previous_darts[i] = darts[i][:]


try:
    while running:
        # Poll for events
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_r:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            process.kill()
                    process = start_widget_process()
                elif event.key == pygame.K_p:
                    # Capture screenshot using the last rendered raw frame
                    if last_frame is not None:
                        capture_screenshot(last_frame)
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 3:
                if pygame.time.get_ticks() - last_right_click < DOUBLE_CLICK_THRESHOLD:
                    # Clear all darts on double right-click
                    darts = [[-1, -1] for _ in range(12)]
                else:
                    last_right_click = pygame.time.get_ticks()
        
        # Render the frame buffer
        if shm_pdi.buf[0] == 0:
            frame = np.frombuffer(shm_pdi.buf[1:widget_size[0]*widget_size[1]*3+1], dtype=np.uint8)
            frame = frame.reshape((widget_size[1], widget_size[0], 3))

            # Store last rendered raw frame for screenshots
            last_frame = frame.copy()

            # Render with optimized function
            out_frame_main, out_frame_small = render_frame_optimized(
                frame, widget_size, out_frame_main, out_frame_small
            )

            # Convert to surface and blit to pygame screen
            surface_main = pygame.surfarray.make_surface(np.transpose(out_frame_main, (1, 0, 2)))
            surface_small = pygame.surfarray.make_surface(np.transpose(out_frame_small, (1, 0, 2)))
            screen.blit(background, (0, 0))
            screen.blit(surface_main, (38, 38))
            screen.blit(surface_small, (125, 603))
            pygame.display.flip()
            shm_pdi.buf[0] = 1

        # Update button state only if changed
        keys = pygame.key.get_pressed()
        button = get_button_state(keys)
        if button != previous_button_state:
            shm_pdo.buf[0] = button
            previous_button_state = button

        # Handle dart placement with left mouse button
        if pygame.mouse.get_pressed()[0]:
            mouse_x, mouse_y = pygame.mouse.get_pos()
            if is_within_dart_area(mouse_x, mouse_y):
                x, y = coords_to_dart_position(mouse_x, mouse_y)
                
                # Determine dart index based on function keys (F1-F12 map to darts 0-11)
                dart_index = 0
                for f_key in range(pygame.K_F1, pygame.K_F13):
                    if keys[f_key]:
                        dart_index = f_key - pygame.K_F1
                        break
                
                darts[dart_index] = [x, y]
        
        # Handle dart removal with right mouse button
        elif pygame.mouse.get_pressed()[2]:
            mouse_x, mouse_y = pygame.mouse.get_pos()
            if is_within_dart_area(mouse_x, mouse_y):
                x, y = coords_to_dart_position(mouse_x, mouse_y)
                for i in range(12):
                    if darts[i] == [x, y]:
                        darts[i] = [-1, -1]
                        break
        
        # Update darts in shared memory (only if changed)
        update_darts_in_shared_memory(shm_pdo, darts, previous_darts)
        
        clock.tick(FPS) 
except KeyboardInterrupt:
    print("Process interrupted by user")
finally:
    pygame.quit()
    process.terminate()
    if 'frame' in locals():
        del frame
    shm_pdo.close()
    shm_pdo.unlink()
    shm_pdi.close()
    shm_pdi.unlink()