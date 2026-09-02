# Tauri 2 backend

Rust owns desktop capabilities. React/Vite remains renderer and keeps the
existing `window.dartsnutApi` contract through `renderer/tauriApi.ts`.

Cargo replacement surface:

- `rig-agent` powers production agent orchestration and streaming; the
  feasibility prototype in `apps/desktop/rig-spike` locks provider, retry,
  cancellation, persistence, and 128-turn behavior.
- `reqwest`/`serde` provide the OpenAI-compatible Responses transport boundary.
- `russh`/`russh-sftp` provide password SSH, explicit host-key policy, command
  streaming, EOF-delimited scripts, and SFTP upload.
- Tokio process, proxy, workspace, and provider modules hold cross-platform
  backend primitives.
- Rust agent runtime provides 128-turn persisted sessions, previous-response
  chaining, retries, cancellation, namespaced streaming events, and workspace
  DynamicTools (`list_files`, `read_file`, `write_file`, `replace_in_file`,
  `grep_files`, `glob_files`, `copy_asset_file`, `copy_chat_attachment`,
  `get_dartsnut_skill`, `check_python`, emulator controls/scenarios, user
  questions, PixelLab generation, and machine MCP).
- Every former renderer invoke name is registered in the Tauri command handler;
  unavailable hosted tools return an explicit `unsupported` response.
- Official Tauri plugins are registered for updater, opener, dialogs,
  clipboard, filesystem, store, window state, and process control.

Updater endpoint is configured in `tauri.conf.json`; release builds must set
`TAURI_SIGNING_PUBLIC_KEY`, `TAURI_SIGNING_PRIVATE_KEY`, and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The public key is injected into the
runtime plugin and signatures are verified before installation.

`cargo check` and packaged builds require network access for uncached crates and
platform signing credentials. Never enable trust-all host keys or log provider
secrets. Hosted web search and code interpreter are intentionally unsupported
by the revised feature set. PixelLab and machine MCP use authenticated HTTP
bridges with workspace-safe output handling.
Safe sideload reconnects with bounded backoff; proxy/PAC routing fails closed
when policy cannot be resolved.
