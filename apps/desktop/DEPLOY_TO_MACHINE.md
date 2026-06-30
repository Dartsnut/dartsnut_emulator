# Deploy to machine (debug)

The **Deploy** panel in Dartsnut Agent appears when the open workspace has a valid root `conf.json` (`id`, `type`: `widget` | `game`). It syncs the workspace to a Raspberry Pi-style host under **`~/dartsnut_rpi/apps/<id>/`** over SSH (default dev credential **`rpi` / `rpi`**).

**Desktop OS:** Bundling uses the **`tar`** CLI on your machine (Electron main process). **Windows 10+** ships **`tar.exe`** (BSD/libarchive) with the flags we use (`--format ustar`, gzip); **macOS** and typical Linux installs are supported. **ssh2** is pure Node and works on Windows without OpenSSH being required for the app (TCP from Electron to the Pi).

## Controls

- **Connect** — SSH to the device, probe whether vendored **`~/dartsnut_rpi/uv`** exists (log **uv app venvs** vs **legacy venv0**), read **`~/dartsnut_rpi/device.json`** → `name` for the UI label, then **`sudo pkill -f`** any command line matching **`dartsnut_rpi/apps/<any id>/main.py`** so no stale debug app **`main.py`** is left running (not limited to the open workspace’s **`id`**). If **`dartsnut_python.service`** is **not** **active** (e.g. left stopped after a dropped connection), **`systemctl restart`** restores it; if already active, the unit is left alone. The primary button reads **Disconnect** while connected; the IP field is locked until you disconnect.
- **Disconnect** — Stop the remote log tail locally, kill the debug PID (if any), **`pkill`** matching **`apps/*/main.py`**, **`systemctl restart dartsnut_python.service`**, then close the SSH session.
- **Run** — Pack the workspace (`tar`), upload, extract under **`~/dartsnut_rpi/apps/<id>/`**, **`systemctl stop dartsnut_python.service`**, then start **`…/main.py`**. On **uv firmware** (executable **`~/dartsnut_rpi/uv`**), Run/Reload first calls firmware **`ensure_app_venv`** (per-app **`uv sync`**, default **`pyproject.toml`** when missing), then **`exec apps/<id>/.venv/bin/python -u main.py`** with **`cwd`** **`apps/<id>/`**. On **legacy** images without **`uv`**, the launcher still uses **`venv0/bin/python`** and an absolute path to **`main.py`**. The tarball carries **source/assets**; widget **runtime JSON** is **`JSON.stringify`** from IPC on each Run/Reload after the fresh sync. **Widgets**: the SSH bootstrap **`sudo tee /tmp/dartsnut_deploy_inner.sh <<'…'`** writes a small runner script (base64-decode → **`PARAMS`**, then **`exec python … --params "$PARAMS"`**); **`sudo bash`** runs that file — no fragile **`sudo bash -c "\"…\""`** embedding JSON. Games omit **`--params`**. Logs append to **`/tmp/dartsnut_deploy.log`**. Not the repo-root **`main.py`** used by **`dartsnut_python.service`**. Manual sideload on the device matches this model; see **`dartsnut_rpi/docs/sideload-game.md`**.
- **Display** — Widget code often expects the LED/matrix stack (**`dartsnut_matrix.service`**) and **`/dev/shm/pdishm`** / **`pdoshm`**. If the matrix service is stopped, you may get a blank panel even when Python is running. Check **`sudo systemctl status dartsnut_matrix.service`**. The production unit logs to **journald** (`journalctl -u dartsnut_python.service -f`); the deploy log is only for this debug launch.
- **Reload** — Pack and sync the latest workspace first. If the sync succeeds, stop **`dartsnut_python.service`**, kill the saved debug PID/process group plus matching **`apps/<id>/main.py`** processes, then restart the debug Python command (re-runs **`ensure_app_venv`** on uv firmware when deps/version stamp changed). If packaging/upload/extract fails, the currently running debug app is left alone. Does **not** start **`dartsnut_python.service`**.
- **Stop** — Stop tail locally, kill the saved debug PID/process group plus matching **`apps/<id>/main.py`** processes, **`sudo rm -rf ~/dartsnut_rpi/apps/<id>`** (needed when debug Python wrote cache files as root), then **`systemctl start dartsnut_python.service`**. **Run** and **Reload** overwrite **`apps/<id>`** the same way before **`mv`** staging into place.

## Widget parameters vs root `main.py`

The repository **`main.py`** on the device starts the full machine runtime (display, WebSocket, **`init_widgets`**, etc.).

Individual **widget** code lives under **`~/dartsnut_rpi/apps/<widget_id>/main.py`**. The stack **does not** pass widget field JSON into the repo-root **`main.py`**. Instead, **`widget_lifecycle`** spawns each widget process with (see **`dartsnut_rpi/widget_lifecycle.py`**):

- **`--params`** — JSON from processed widget fields for that instance (from **`apps/conf.json`** page entries).
- **`--shm`** — shared memory name for the framebuffer bridge.
- **`--data-store`** — per-widget user data path.

So for a widget to receive runtime params on hardware, the device’s **`apps/conf.json`** must list that widget id with the appropriate **`fields`**. Syncing only **`apps/<id>/`** from the desktop does not automatically create or update that page configuration.

## Manual QA

1. Valid **`conf.json`** → Deploy tab visible; invalid/missing → tab hidden.
2. **Connect** with a reachable host → device name or empty if **`device.json`** missing; button becomes **Disconnect**.
3. **Disconnect** → kills matching **`apps/*/main.py`** processes, **`dartsnut_python.service`** restarts, SSH closes.
4. **Run** → status lines and Python logs appear in the panel.
5. **Reload** → workspace syncs again, process restarts with latest files; service stays stopped until **Stop**.
6. **Stop** → remote **`apps/<id>`** removed and **`dartsnut_python.service`** started.
