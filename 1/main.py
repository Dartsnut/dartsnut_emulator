from PIL import Image, ImageDraw
import signal
import sys
import time
import numpy
import json
import base64
import time
import os
from io import BytesIO
import dartsnut

dartsnut = dartsnut.Dartsnut()

default_params = {
    "file": "",
    "text": "Hello, World!",
    "color": (255, 255, 255),
    "dropdown": "0",
    "toggle": True,
    "number": 42,
    "slider": 50,
    "checkbox": ["A", "B"]
}

# Ensure all parameters are defined, otherwise load default values
for key, value in default_params.items():
    if key not in dartsnut.widget_params:
        dartsnut.widget_params[key] = value

currentImage = Image.new("RGB",(128,128))

if (dartsnut.widget_params.get("files","") != ""):
    if len(dartsnut.widget_params["files"]) > 0:
        with open(dartsnut.widget_params["files"][0], "rb") as f:
            file_ext = os.path.splitext(dartsnut.widget_params["files"][0])[1][1:].lower()
            file_data = f.read()
            if file_ext in ["jpg", "bmp", "png"]:
                image = Image.open(BytesIO(file_data)).resize((128,128))
                currentImage.paste(image, (0, 0))
        # delete the temp file
        try:
            os.remove(dartsnut.widget_params["files"][0])
        except Exception as e:
            print(f"Failed to delete temp file {file_path}: {e}")

draw = ImageDraw.Draw(currentImage)
draw.text((0, 0), dartsnut.widget_params["text"], dartsnut.widget_params["color"], font_size=14)
draw.text((0, 15), "dropdown: "+dartsnut.widget_params["dropdown"], dartsnut.widget_params["color"], font_size=14)
draw.text((0, 30), "toggle: "+str(dartsnut.widget_params["toggle"]), dartsnut.widget_params["color"], font_size=14)
draw.text((0, 45), "number: "+str(dartsnut.widget_params["number"]), dartsnut.widget_params["color"], font_size=14)
draw.text((0, 60), "slider: "+str(dartsnut.widget_params["slider"]), dartsnut.widget_params["color"], font_size=14)
draw.text((0, 75), "checkbox: ", dartsnut.widget_params["color"], font_size=14)
for i, item in enumerate(dartsnut.widget_params["checkbox"]):
    draw.text((i * 8 + 75, 75), f"{item}", dartsnut.widget_params["color"], font_size=14)

dartsnut.update_frame_buffer(currentImage)

try:
    while True:
        time.sleep(1)
        dartsnut.update_frame_buffer(currentImage)

except KeyboardInterrupt:
    print("simple_demo exiting...")