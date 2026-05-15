import json
import os
import queue
import sys
import threading
import time
from typing import Any

from core import EmulatorCore


def emit(event: str, payload: dict[str, Any]) -> None:
    print(json.dumps({"event": event, "payload": payload}), flush=True)


def _pump_stdin_lines(command_queue: queue.Queue[str]) -> None:
    """Blocking stdin read on a thread — `select` does not support stdin on Windows."""
    while True:
        try:
            raw = sys.stdin.readline()
        except (OSError, ValueError):
            return
        if raw == "":
            return
        command_queue.put(raw)


def main() -> None:
    workspace_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    core = EmulatorCore(workspace_root=workspace_root)
    last_heartbeat_ms = 0
    command_queue: queue.Queue[str] = queue.Queue()
    stdin_thread = threading.Thread(target=_pump_stdin_lines, args=(command_queue,), daemon=True)
    try:
        emit("ready", core.snapshot())
        stdin_thread.start()

        while True:
            got_stdin_line = False
            while True:
                try:
                    raw = command_queue.get_nowait()
                except queue.Empty:
                    break
                got_stdin_line = True
                stripped = raw.strip()
                if not stripped:
                    continue
                try:
                    request = json.loads(stripped)
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
            if not got_stdin_line:
                time.sleep(0.01)
    finally:
        core.shutdown()


if __name__ == "__main__":
    main()
