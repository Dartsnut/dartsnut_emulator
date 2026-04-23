import json
import os
import select
import sys
import time
from typing import Any

from core import EmulatorCore


def emit(event: str, payload: dict[str, Any]) -> None:
    print(json.dumps({"event": event, "payload": payload}), flush=True)


def main() -> None:
    workspace_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    core = EmulatorCore(workspace_root=workspace_root)
    last_heartbeat_ms = 0
    try:
        emit("ready", core.snapshot())

        while True:
            readable, _, _ = select.select([sys.stdin], [], [], 0.01)
            if readable:
                raw = sys.stdin.readline()
                if raw == "":
                    time.sleep(0.1)
                    continue
                try:
                    request = json.loads(raw)
                    command = request.get("command", {})
                    next_state = core.apply_command(command)
                    emit("state", next_state)
                except Exception as exc:  # pragma: no cover - defensive
                    emit("error", {"message": str(exc)})
            frame_payload = core.read_latest_frame()
            if frame_payload is not None:
                emit("frame", frame_payload)
            for entry in core.poll_widget_logs():
                emit("log", entry)
            now_ms = int(time.time() * 1000)
            if now_ms - last_heartbeat_ms >= 500:
                emit("heartbeat", core.snapshot())
                last_heartbeat_ms = now_ms
    finally:
        core.shutdown()


if __name__ == "__main__":
    main()
