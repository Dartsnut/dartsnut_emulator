import sys
from multiprocessing import shared_memory
import subprocess
import os
import numpy as np
import pygame
import json
import argparse
import sys
import tempfile

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

shm_pdi_name = "shmpdi"
# remove the previous shared memory if it exists
try:
    existing_shm_pdi = shared_memory.SharedMemory(name=shm_pdi_name)
    existing_shm_pdi.close()
    shared_memory.SharedMemory(name=shm_pdi_name).unlink()
except FileNotFoundError:
    pass
except FileExistsError:
    shared_memory.SharedMemory(name=shm_pdi_name).unlink()

# init the shm for display
shm_pdi = shared_memory.SharedMemory(name=shm_pdi_name, create=True, size=128*160*3+1)

# create the shared memory for darts and buttons
shm_pdo_name = "pdoshm"
# remove the previous shared memory if it exists
try:
    existing_shm_pdo = shared_memory.SharedMemory(name=shm_pdo_name)
    existing_shm_pdo.close()
    shared_memory.SharedMemory(name=shm_pdo_name).unlink()
except FileNotFoundError:
    pass
except FileExistsError:
    shared_memory.SharedMemory(name=shm_pdo_name).unlink()
shm_pdo = shared_memory.SharedMemory(name=shm_pdo_name, create=True, size=49)  # 12 darts, each with x and y coordinates

# read the conf.json at args.path/conf.json to get the display mode
with open(os.path.join(os.getcwd(), args.path, "conf.json")) as f:
    config = json.load(f)
params = json.loads(args.params)

for param in config["fields"]:
    if param["type"] == "files":
        # if the param is of type files, and the params has it, convert the list to absolute path
        if param["id"] in params:
            file_list = params[param["id"]]
            temp_files = []
            for file_path in file_list:
                with open(os.path.join(os.getcwd(), args.path, file_path), "rb") as src_file:
                    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=os.path.splitext(file_path)[1])
                    temp_file.write(src_file.read())
                    temp_file.close()
                    temp_files.append(temp_file.name)
            params[param["id"]] = temp_files

# start the process
command = [sys.executable, os.path.join(os.getcwd(), args.path, "main.py")]
command.extend(["--params", json.dumps(params)])
command.extend(["--shm",shm_pdi_name])
process = subprocess.Popen(
    command,
    cwd=args.path,
)

#init pygame
pygame.init()

display_size = config.get("size", [128,160])
screen = pygame.display.set_mode((display_size[0]*8, display_size[1]*8))
pygame.display.set_caption("Dartsnut Emulator - " + config.get("name", "Unknown Widget"))
clock = pygame.time.Clock()
running = True
last_right_click = 0

#init darts
darts = [[-1, -1] for _ in range(12)]

try:
    while running:
        # poll for events
        # pygame.QUIT event means the user clicked X to close your window
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 3:
                if pygame.time.get_ticks() - last_right_click < 500:
                    # clear all darts
                    darts = [[-1, -1] for _ in range(12)]
                else:
                    last_right_click = pygame.time.get_ticks()
                
        
        # render the frame buffer
        if shm_pdi.buf[0] == 0:
            frame = np.frombuffer(shm_pdi.buf[1:display_size[0]*display_size[1]*3+1], dtype=np.uint8)
            frame = frame.reshape((display_size[1], display_size[0], 3))

            # Enlarge pixels and add borders
            height, width, channels = frame.shape
            scale = 8
            border = 1
            out_height = height * scale
            out_width = width * scale
            out_frame = np.zeros((out_height, out_width, channels), dtype=np.uint8)

            if display_size == [128, 160]:
                for y in range(128):
                    for x in range(128):
                        y_start = y * scale
                        x_start = x * scale
                        out_frame[y_start:y_start+scale, x_start:x_start+scale] = [0, 0, 0]
                        out_frame[y_start+border:y_start+scale-border, x_start+border:x_start+scale-border] = frame[y, x]
                for y in range(128, 160):
                    for x in range(64):
                        y_start = y * scale
                        x_start = x * scale + 32 * scale
                        out_frame[y_start:y_start+scale, x_start:x_start+scale] = [0, 0, 0]
                        out_frame[y_start+border:y_start+scale-border, x_start+border:x_start+scale-border] = frame[y, x]
            else:
                for y in range(height):
                    for x in range(width):
                        y_start = y * scale
                        x_start = x * scale
                        out_frame[y_start:y_start+scale, x_start:x_start+scale] = [0, 0, 0]
                        out_frame[y_start+border:y_start+scale-border, x_start+border:x_start+scale-border] = frame[y, x]

            # Convert to surface and blit to pygame screen
            surface = pygame.surfarray.make_surface(np.transpose(out_frame, (1, 0, 2)))
            screen.blit(surface, (0, 0))
            pygame.display.flip()
            shm_pdi.buf[0] = 1

        # emulate the button events as button pressed
        button = 0  # Reset button state
        keys = pygame.key.get_pressed()
        if keys[pygame.K_k]:
            button |= 0x01  # Button A
        if keys[pygame.K_l]:
            button |= 0x02   # Button B pressed
        if keys[pygame.K_a]:
            button |= 0x04  # Button left pressed
        if keys[pygame.K_w]:
            button |= 0x08  # Button up pressed
        if keys[pygame.K_d]:
            button |= 0x10
        if keys[pygame.K_s]:
            button |= 0x20  # Button down pressed
        shm_pdo.buf[0] = button

        # emulate the click event as dart hits
        if pygame.mouse.get_pressed()[0]:  # Left mouse button
            mouse_x, mouse_y = pygame.mouse.get_pos()
            # map to 128*128 pixels
            if (mouse_x <= 128*8) & (mouse_y <= 128*8):
                x = mouse_x // 8 * 299 + 1800
                y = mouse_y // 8 * 299 + 1800
                if pygame.key.get_pressed()[pygame.K_F2]:
                    darts[1] = [x, y]
                elif pygame.key.get_pressed()[pygame.K_F3]:
                    darts[2] = [x, y]
                elif pygame.key.get_pressed()[pygame.K_F4]:
                    darts[3] = [x, y]
                elif pygame.key.get_pressed()[pygame.K_F5]:
                    darts[4] = [x, y]
                elif pygame.key.get_pressed()[pygame.K_F6]:
                    darts[5] = [x, y]
                elif pygame.key.get_pressed()[pygame.K_F7]:
                    darts[6] = [x, y]
                elif pygame.key.get_pressed()[pygame.K_F8]:
                    darts[7] = [x, y]
                elif pygame.key.get_pressed()[pygame.K_F9]:
                    darts[8] = [x, y]
                elif pygame.key.get_pressed()[pygame.K_F10]:
                    darts[9] = [x, y]
                elif pygame.key.get_pressed()[pygame.K_F11]:
                    darts[10] = [x, y]
                elif pygame.key.get_pressed()[pygame.K_F12]:
                    darts[11] = [x, y]
                else:
                    darts[0] = [x, y]
                    
        elif pygame.mouse.get_pressed()[2]:  # Right mouse button
            mouse_x, mouse_y = pygame.mouse.get_pos()
            # map to 128*128 pixels
            if (mouse_x <= 128*8) & (mouse_y <= 128*8):
                x = mouse_x // 8 * 299 + 1800
                y = mouse_y // 8 * 299 + 1800
                for i in range(12):
                    if darts[i] == [x, y]:
                        darts[i] = [-1, -1]
        # set the darts in the shared memory
        for i in range(12):
            if darts[i][0] == -1 and darts[i][1] == -1:
                shm_pdo.buf[i*4+1:i*4+3] = (0xffff).to_bytes(2, 'little')
                shm_pdo.buf[i*4+3:i*4+5] = (0xffff).to_bytes(2, 'little')
            else:
                shm_pdo.buf[i*4+1:i*4+3] = (darts[i][0]).to_bytes(2, 'little')
                shm_pdo.buf[i*4+3:i*4+5] = (darts[i][1]).to_bytes(2, 'little')
    
        clock.tick(60) 
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