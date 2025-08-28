from multiprocessing import shared_memory, resource_tracker
import argparse
import sys
import json
import math

class Dartsnut:
    def __init__(self):
        # prevent the shared memory from being tracked by resource_tracker
        self.remove_shm_from_resource_tracker()

        # parse the arguments
        parser = argparse.ArgumentParser(description="Dartsnut")
        parser.add_argument(
            "--params",
            type=str,
            default="{}",
            help="JSON string for widget parameters"
        )
        parser.add_argument(
            "--shm",
            type=str,
            default="pdishm",
            help="Shared memory name"
        )
        args = parser.parse_args()
        # load the parameters
        try:
            self.widget_params = json.loads(args.params)
        except json.JSONDecodeError as e:
            print(args.params)
            print(f"Error decoding JSON: {e}")
            sys.exit(1)
        # load the shared memory for display
        try:
            self.shm = shared_memory.SharedMemory(name=args.shm, create=False)
        except FileNotFoundError:
            print(f"Shared memory file '{args.shm}' not found.")
            sys.exit(1)
        # map the input shared memory
        try:
            self.shm_pdo = shared_memory.SharedMemory(name="pdoshm", create=False)
        except FileNotFoundError:
            print(f"Shared memory file 'pdoshm' not found.")
            sys.exit(1)
        self.shm_buffer = self.shm.buf
        self.shm_pdo_buf = self.shm_pdo.buf

    def remove_shm_from_resource_tracker(self):
        """Monkey-patch multiprocessing.resource_tracker so SharedMemory won't be tracked

        More details at: https://bugs.python.org/issue38119
        """

        def fix_register(name, rtype):
            if rtype == "shared_memory":
                return
            return resource_tracker._resource_tracker.register(name, rtype)
        resource_tracker.register = fix_register

        def fix_unregister(name, rtype):
            if rtype == "shared_memory":
                return
            return resource_tracker._resource_tracker.unregister(name, rtype)
        resource_tracker.unregister = fix_unregister

        if "shared_memory" in resource_tracker._CLEANUP_FUNCS:
            del resource_tracker._CLEANUP_FUNCS["shared_memory"]

    def update_frame_buffer(self, frame):
        """Update the shared memory buffer with the given image or buffer."""
        if isinstance(frame, bytearray):
            image_bytes = frame
        elif hasattr(frame, 'tobytes'):
            image_bytes = frame.tobytes()
        else:
            raise TypeError("frame must be a bytearray or have a 'tobytes' method")
        
        shm_buffer = self.shm_buffer
        if (shm_buffer[0] == 2):
            return False
        elif (shm_buffer[0] == 1):
            shm_buffer[1:len(image_bytes)+1] = image_bytes
            shm_buffer[0] = 0
            return True
        else:
            return False

    def get_darts(self):
        darts = []
        buf = self.shm_pdo_buf
        for i in range(12):
            x = buf[i*4+1] + (buf[i*4+2] << 8)
            y = buf[i*4+3] + (buf[i*4+4] << 8)
            if (x != 0xffff) & (y != 0xffff):
                if (y <= 1800):
                    y_mapped = 0
                elif (y >= 39800):
                    y_mapped = 127
                else:
                    y_mapped = math.floor((y - 1800) / 299)
                
                if (x <= 1800):
                    x_mapped = 0
                elif (x >= 39800):
                    x_mapped = 127
                else:
                    x_mapped = math.floor((x - 1800) / 299)
                darts.append([x_mapped, y_mapped])
            else:
                darts.append([-1, -1])
        return darts

    def get_buttons(self):
        return self.shm_pdo_buf[0]

    def set_brightness(self, brightness):
        if (10 <= brightness <= 100):
            self.shm_pdo_buf[49] = brightness