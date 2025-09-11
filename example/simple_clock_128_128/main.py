from PIL import Image, ImageDraw, ImageFont
import math
import time
from pydartsnut import Dartsnut
import zoneinfo
import datetime
import requests

dartsnut = Dartsnut()
#read the city from params
city_name = dartsnut.widget_params.get("city", "")

if city_name != "":
    while True:
        try:
            resp = requests.get(
                "https://secure.geonames.org/searchJSON",
                params={"q": city_name, "maxRows": 1, "username": "sz1jrh"}
            )
            data = resp.json()
            if data["geonames"]:
                lat = data["geonames"][0]["lat"]
                lng = data["geonames"][0]["lng"]
                city = data["geonames"][0]["name"]
                # Step 2: Get timezone and local time
                tz_resp = requests.get(
                    "https://secure.geonames.org/timezoneJSON",
                    params={"lat": lat, "lng": lng, "username": "sz1jrh"}
                )
                tz_data = tz_resp.json()
                timezone = tz_data['timezoneId']
            else:
                timezone = None
                city = "Unknown"
            break
        except Exception as e:
            print(f"Error fetching location data: {e}")
        # Wait a bit before retrying
        time.sleep(2)
else:
    timezone = None
    city = "Unknown"

def draw_clock(city="Shenzhen", tz="Asia/Shanghai"):
    # Create a blank image (128x128, black background)
    img = Image.new("RGB", (128, 128), "black")
    draw = ImageDraw.Draw(img)

    if tz is None:
        # Display "City not found" message
        msg = "City not found"
        text_bbox = draw.textbbox((0, 0), msg, font_size=16)
        text_w = text_bbox[2] - text_bbox[0]
        text_h = text_bbox[3] - text_bbox[1]
        text_x = (128 - text_w) // 2
        text_y = (128 - text_h) // 2
        draw.text((text_x, text_y), msg, fill="red", font_size=16)

    else:
        # Draw the city name at the bottom
        font = ImageFont.load_default()
        city_bbox = draw.textbbox((0, 0), city, font=font)
        city_w = city_bbox[2] - city_bbox[0]
        city_x = 0 + (128 - city_w) // 2
        city_y = 85
        draw.text((city_x, city_y), city, fill="lightgray", font=font)

        # Clock center and radius
        cx, cy, r = 64, 64, 60

        # Draw simple clock face (white outline)
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline="white", width=2)

        # Draw hour marks (white ticks)
        for i in range(12):
            angle = math.radians(i * 30 - 90)
            x1 = cx + int((r - 8) * math.cos(angle))
            y1 = cy + int((r - 8) * math.sin(angle))
            x2 = cx + int(r * math.cos(angle))
            y2 = cy + int(r * math.sin(angle))
            draw.line((x1, y1, x2, y2), fill="white", width=2)

        # Get current time
        tz = zoneinfo.ZoneInfo(tz)
        now_dt = datetime.datetime.now(tz)
        now = now_dt.timetuple()
        # now = time.localtime()
        hour = now.tm_hour % 12
        minute = now.tm_min
        second = now.tm_sec

        # Draw hour hand (white)
        hour_angle = math.radians((hour + minute / 60) * 30 - 90)
        hx = cx + int((r - 28) * math.cos(hour_angle))
        hy = cy + int((r - 28) * math.sin(hour_angle))
        draw.line((cx, cy, hx, hy), fill="white", width=5)

        # Draw minute hand (gray)
        min_angle = math.radians((minute + second / 60) * 6 - 90)
        mx = cx + int((r - 16) * math.cos(min_angle))
        my = cy + int((r - 16) * math.sin(min_angle))
        draw.line((cx, cy, mx, my), fill="gray", width=3)

        # Draw second hand (red)
        sec_angle = math.radians(second * 6 - 90)
        sx = cx + int((r - 10) * math.cos(sec_angle))
        sy = cy + int((r - 10) * math.sin(sec_angle))
        draw.line((cx, cy, sx, sy), fill="red", width=1)

    return img


# display
try:
    while True:
        dartsnut.update_frame_buffer(draw_clock(city=city, tz=timezone))
        time.sleep(0.5)

except KeyboardInterrupt:
    print("simple_demo exiting...")