import json
import os
import queue
import signal
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
    def _exit_on_signal(signum: int, _frame: object) -> None:
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, _exit_on_signal)
    signal.signal(signal.SIGINT, _exit_on_signal)

    workspace_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    core = EmulatorCore(workspace_root=workspace_root)
    last_heartbeat_ms = 0
    last_diag_ms = 0
    command_queue: queue.Queue[str] = queue.Queue()
    rgb_stall_started_ms: int | None = None
    last_stall_warn_ms = 0
    stdin_thread = threading.Thread(target=_pump_stdin_lines, args=(command_queue,), daemon=True)
    try:
        emit("ready", core.snapshot())
        stdin_thread.start()

        while True:
            now_ms = int(time.time() * 1000)
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
                    action = command.get("type") if isinstance(command, dict) else None
                    next_state = core.apply_command(command)
                    emit("state", next_state)
                    if action == "shutdown":
                        break
                except Exception as exc:  # pragma: no cover - defensive
                    emit("error", {"message": str(exc)})
            frame_payload = core.read_latest_frame()
            if frame_payload is not None:
                emit("frame", frame_payload)
                rgb_stall_started_ms = None
                last_stall_warn_ms = 0
            else:
                proc = core.widget_process
                alive = proc is not None and proc.poll() is None
                gate = int(core.shm_pdi.buf[0]) if core.shm_pdi is not None else -1
                if core.state.running and alive and gate == 1:
                    if rgb_stall_started_ms is None:
                        rgb_stall_started_ms = now_ms
                    elif (
                        now_ms - rgb_stall_started_ms >= 5000
                        and now_ms - last_stall_warn_ms >= 5000
                    ):
                        last_stall_warn_ms = now_ms
                        emit(
                            "log",
                            {
                                "source": "stdout",
                                "text": (
                                    "[bridge] Widget subprocess is alive but the emulator receives no RGB frames "
                                    "(shared-memory gate stays 1). Call pydartsnut Dartsnut.update_frame_buffer "
                                    "each frame from your main loop, or confirm the project uses pydartsnut for display."
                                ),
                                "timestampMs": now_ms,
                            },
                        )
                else:
                    rgb_stall_started_ms = None
            for entry in core.poll_widget_logs():
                emit("log", entry)
            if now_ms - last_heartbeat_ms >= 500:
                emit("heartbeat", core.snapshot())
                last_heartbeat_ms = now_ms
            if now_ms - last_diag_ms >= 2500:
                last_diag_ms = now_ms
                proc = core.widget_process
                if proc is None:
                    poll_status = "no_process"
                    widget_pid: int | None = None
                else:
                    widget_pid = proc.pid
                    pr = proc.poll()
                    poll_status = "alive" if pr is None else f"exited_{pr}"
                gate = int(core.shm_pdi.buf[0]) if core.shm_pdi is not None else -1
                tail = (core._widget_stream_tail or "")[-600:].replace("\n", " | ")
                stall_s = 0
                if rgb_stall_started_ms is not None:
                    stall_s = max(0, (now_ms - rgb_stall_started_ms) // 1000)
                emit(
                    "diag",
                    {
                        "running": core.state.running,
                        "shm_gate": gate,
                        "widget_poll_status": poll_status,
                        "widget_pid": widget_pid,
                        "launch_argv_chars": getattr(core, "_last_launch_argv_chars", -1),
                        "widget_log_tail": tail,
                        "shm_tail": core.shm_pdi_name[-10:],
                        "no_rgb_frame_stall_s": stall_s,
                    },
                )
            if not got_stdin_line:
                time.sleep(0.01)
    finally:
        core.shutdown()


if __name__ == "__main__":
    main()
