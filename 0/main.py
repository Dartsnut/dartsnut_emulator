import base64
import os
from PIL import Image
from io import BytesIO
import numpy
import time
import dartsnut

dartsnut = dartsnut.Dartsnut()
#init the image
currentImage = Image.new("RGB",(128,128))

#resolve the media data
image_array = []
if (dartsnut.widget_params.get("files","") != ""):
    for file_path in dartsnut.widget_params["files"]:
        with open(file_path, "rb") as f:
            file_ext = os.path.splitext(file_path)[1][1:].lower()
            file_data = f.read()
            if file_ext in ["jpg", "bmp", "png"]:
                image = Image.open(BytesIO(file_data)).resize((128,128))
                image_array.append({"fps":0.2, "images":[image]})
            elif file_ext == "gif":
                images = []
                gif = Image.open(BytesIO(file_data))
                for frame in range(gif.n_frames):
                    gif.seek(frame)
                    img = gif.convert("RGB").resize((128, 128))
                    images.append(img)
                if "duration" in gif.info:
                    # duration is in milliseconds per frame
                    duration_ms = gif.info["duration"]
                    if duration_ms > 0:
                        fps = 1000 / duration_ms
                    else:
                        fps = 30
                else:
                    fps = 30  # Unknown FPS
                image_array.append({"fps": fps, "images": images})
            # delete the temp file
            try:
                os.remove(file_path)
            except Exception as e:
                print(f"Failed to delete temp file {file_path}: {e}")

#start the loop
if (len(image_array) > 0):
    image_index = 0
    frame_index = 0
    try:
        while True:
            currentImage.paste(image_array[image_index]["images"][frame_index], (0, 0))
            frame_index += 1
            if frame_index >= len(image_array[image_index]["images"]):
                frame_index = 0
                image_index += 1
                if image_index >= len(image_array):
                    image_index = 0
            dartsnut.update_frame_buffer(currentImage)
            time.sleep(1 / image_array[image_index]["fps"])
            
    except KeyboardInterrupt:
        print("simple_demo exiting...")