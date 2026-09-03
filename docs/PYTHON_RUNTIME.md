# Managed Python runtime

Dartsnut Agent's Tauri backend owns every local Python process. Development and packaged builds use the same managed Python and uv binaries. Host Python, host uv, `PATH` discovery, signed app resources, and `DARTSNUT_PYTHON` are never runtime candidates.

## Pinned targets

`apps/desktop/src-tauri/src/runtime.rs` is the only authoritative target manifest.

| Component | Target |
| --- | --- |
| Python | `3.14.7` |
| python-build-standalone release | `20260901` |
| uv | `0.12.8` |
| Platforms | macOS arm64, Windows x64 |

Each platform archive has a committed SHA-256 digest. Runtime URLs contain exact versions; `LatestRelease` URLs are forbidden.

Before changing target constants or hashes, confirm every archive exists on both GitHub Releases and USTC's GitHub Release mirror. uv `0.12.8` is intentionally pinned because USTC does not mirror `0.12.9`.

## Storage and startup

Tauri stores runtime state under `app.path().app_data_dir()/runtime`:

```text
runtime/
  python-3.14.7/
    base/
    env/
  uv-0.12.8/
  cache/
  staging/
  runtime.json
```

Startup bootstraps only managed Python, uv, and an empty managed venv. It validates metadata, platform, executables, and exact Python and uv versions; it does not read the repository `requirements.txt`, install packages, or import-check workspace packages. A valid bootstrap needs no package-index request. Workspace and tool dependencies are prepared lazily by their owning workflows.

`runtime.json` is written after bootstrap extraction and validation succeed. Interrupted staging never becomes ready. Old versioned runtimes are pruned only after new target is ready.

## Download source selection

For each missing archive, Tauri concurrently probes exact official and USTC URLs with `GET` and `Range: bytes=0-0`. A probe is valid only for HTTP `200` or `206` and a non-empty first response chunk.

- GitHub/CDN redirects are accepted for official downloads.
- A USTC response redirected away from `mirrors.ustc.edu.cn` is rejected. USTC uses that redirect when mirrored asset is absent.
- Fastest valid probe wins. If selected download fails, truncates, times out, or fails SHA-256 verification, other valid source is tried once.
- Downloads use temporary files. Only committed SHA-256 content enters cache.

Progress reports probe, download, verify, extract, install, and validate stages without exposing selected download source or pinned versions in UI. Source and probe latency remain internal metadata. Failure leaves retryable error; UI calls `retry_python_runtime_setup`.

Exact URL patterns:

```text
https://github.com/astral-sh/python-build-standalone/releases/download/<release>/<archive>
https://mirrors.ustc.edu.cn/github-release/astral-sh/python-build-standalone/<release>/<archive>

https://github.com/astral-sh/uv/releases/download/<version>/<archive>
https://mirrors.ustc.edu.cn/github-release/astral-sh/uv/<version>/<archive>
```

## Execution policy

Bridge, asset preprocessing, and syntax checks always use:

```text
<managed-uv> run --no-project --python <managed-python> ...
```

Tauri passes exact `DARTSNUT_UV_BIN` and `UV_PYTHON` paths to emulator bridge. It also sets `UV_NO_MANAGED_PYTHON=1`, `UV_NO_PYTHON_DOWNLOADS=never`, and strips inherited Python/uv overrides.

Before every game or widget launch, bridge runs:

```text
<managed-uv> sync --directory <workspace>
<managed-uv> run --no-sync --directory <workspace> main.py ...
```

`UV_PYTHON` pins workspace sync to managed Python. Launch requires workspace `.venv`; missing managed binaries or workspace Python is fatal. No `sys.executable` fallback exists.

Workspace launch performs `uv sync --directory <workspace>` on demand; this is where project dependencies such as `pygame-ce`, `numpy`, and `pydartsnut` are installed. Asset binding installs pinned `Pillow` (`12.1.1`) on first use if `import PIL` fails, then launches the preprocessor. Repeated launches skip already-importable Pillow. Package-index selection belongs to the workspace/tool workflow; startup does not probe PyPI or persist a package index.

## Version bump checklist

1. Choose stable Python, python-build-standalone release, and uv versions available on official and USTC sources for both supported platforms.
2. Update three target constants, archive mappings if needed, and all four committed SHA-256 values in `runtime.rs`.
3. Update manifest tests and this document.
4. Test fresh install, verified-cache offline startup, macOS arm64 release, and Windows x64 release.

Historical Electron runtime files and `bundle:python` tooling are not used by Tauri builds and are not runtime authority.
