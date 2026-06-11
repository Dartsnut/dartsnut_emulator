# Python runtime (Dartsnut Agent desktop)

Packaged Dartsnut Agent ships its own Python stack so users do not install Python separately.

## What is bundled

| Asset | Build output | Packaged location |
| --- | --- | --- |
| Python venv + emulator deps | `apps/desktop/resources/python-runtime/` | `Contents/Resources/python-runtime` (mac) |
| `uv` binary (platform-specific) | `apps/desktop/resources/uv/` | `Contents/Resources/uv` (mac) |

Built by:

```bash
pnpm bundle:python
```

`bundle:python` runs before `package:*` scripts.

### Python interpreter

- Source: [python-build-standalone](https://github.com/astral-sh/python-build-standalone) (`install_only_stripped`)
- Targets: macOS arm64, Windows x64
- Dependencies: see root `requirements.txt` (aligned with cross-platform packages from `dartsnut_rpi`, excluding Pi-only libs)

### uv runner

- Source: [Astral uv releases](https://github.com/astral-sh/uv/releases) (pinned in `scripts/build_bundled_python.mjs`)
- Matches the model used on device firmware (`dartsnut_rpi` vendored `uv` + `uv sync` / `uv run`)

## How scripts are launched

### Packaged app

### Bridge and asset scripts (global emulator deps)

The bridge process and one-shot tools (e.g. asset preprocess) use **bundled** `python-runtime` with `uv run --no-project` when `DARTSNUT_UV_BIN` is set (packaged builds):

### Workspace widget/game preview (per-project venv)

When a workspace is loaded, the bridge mirrors `dartsnut_rpi` `ensure_app_venv`:

1. If `pyproject.toml` is missing, materialize the managed default for `conf.json` `type` (`game` or `widget`) from `services/emulator-core/app_defaults/`.
2. Run `uv sync --directory <workspace>` using bundled uv + bundled base Python (`UV_PYTHON`).
3. Launch with `uv run --directory <workspace> main.py …` so the workspace `.venv` is used (same model as deploy on device).

If the workspace already has a custom `pyproject.toml` (not a managed default), it is synced as-is.

```bash
uv run --no-project --python <bundled-venv-python> <script.py> [args...]
```

Offline env vars (set by `apps/desktop/pythonRuntime.ts`):

| Variable | Value | Purpose |
| --- | --- | --- |
| `UV_NO_PYTHON_DOWNLOADS` | `never` | Do not fetch Python at runtime |
| `UV_NO_MANAGED_PYTHON` | `1` | Disable uv-managed interpreters |
| `UV_NO_PROJECT` | `1` | Do not walk up for `pyproject.toml` / `.venv` (also avoids runtime dep sync) |
| `DARTSNUT_UV_BIN` | bundled `uv` binary | Widget/game spawns in `core.py` |
| `UV_PYTHON` | bundled venv `python` | Pin interpreter |
| `VIRTUAL_ENV` | bundled venv dir | Activate bundled site-packages |
| `PYTHONUNBUFFERED` | `1` | Line-buffered stdout/stderr |

**Why `--no-project` is required:** without it, `uv run` from a repo-like cwd can recreate `.venv` and sync a project.

### Dev (`pnpm dev`)

- Spawns `.venv/bin/python` directly (after `pnpm setup:python`)
- Does not require bundled `uv` unless you built resources locally

### Overrides

- `DARTSNUT_PYTHON` — force a specific interpreter (direct spawn, no uv wrapper)

## What is intentionally excluded

Emulator `requirements.txt` does **not** include Raspberry Pi–only packages from `dartsnut_rpi` (`bluezero`, `dbus-python`, `pybluez-dartsnut`, `evdev`, widget `aiohttp`, firmware `fastapi`/`uvicorn`/`websockets`). Those are installed on the device via firmware `uv sync` when deploying.

## Troubleshooting (Windows)

### “Bundled Python runtime is not ready”

The packaged app expects a **Windows-built** venv at:

`resources/python-runtime/Scripts/python.exe` (next to the `.exe`)

**Build on the Windows machine** (do not copy a Mac `python-runtime` folder):

```bash
pnpm bundle:python -- --target win-x64
pnpm --dir apps/desktop run package:win
```

Verify before packaging:

```text
apps/desktop/resources/python-runtime/Scripts/python.exe
apps/desktop/resources/python-runtime/.bundled-python.json   → "target": "win-x64"
apps/desktop/resources/uv/uv.exe
```

After packaging, check the portable output:

```text
release/Dartsnut Agent.exe   (or win-unpacked/resources/python-runtime/...)
```

**Offline / flaky network:** cache downloads manually (see `scripts/build_bundled_python.mjs`):

| Asset | Cache path |
| --- | --- |
| Python 3.12.7 standalone | `.cache/python-build-standalone/cpython-3.12.7+20241016-x86_64-pc-windows-msvc-shared-install_only_stripped.tar.gz` |
| uv 0.11.19 | `.cache/uv/0.11.19/uv-x86_64-pc-windows-msvc.zip` |

`uv pip install` still needs PyPI (or a prebuilt venv) unless you copy a completed `apps/desktop/resources/python-runtime/` from a successful build.

**Shared MSVC runtime:** the Windows standalone build is `*-shared-*`; install [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist) if `python.exe` fails to start with a DLL error.

**Wrong-platform bundle:** if `.bundled-python.json` says `darwin-arm64` inside a Windows package, rebuild `bundle:python` on Windows.

## Related files

- `scripts/build_bundled_python.mjs` — download Python + uv, create venv, install deps
- `apps/desktop/pythonRuntime.ts` — spawn helpers for bridge and asset pipeline
- `apps/desktop/main.ts` — bridge process lifecycle
- `apps/desktop/assetManager.ts` — asset preprocess invocations
