## Why

The desktop agent UI currently reserves the right side as empty space, while the emulator implementation already exists in a separate repository. We need to consolidate these into one desktop app so users can chat, preview, interact with widgets, and drive Python-backed emulator behavior in one workflow.

## What Changes

- Add a full-featured right-side emulator pane to the desktop renderer, matching existing emulator behavior parity (canvas rendering, dart interactions, zoom, params editor, and logs drawer).
- Port emulator IPC contracts and preload bridge surface into this repository so renderer and main process can exchange emulator commands, state, frames, and logs.
- Integrate Python bridge process lifecycle management in Electron main process (startup, state updates, frame/log forwarding, and shutdown handling).
- Keep existing left-side agent/chat behavior intact while replacing the right blank area with the functional emulator panel.

## Capabilities

### New Capabilities
- `desktop-right-pane-emulator`: Full emulator runtime integration inside the desktop app right pane, including UI controls, rendering, interactions, IPC bridge, and Python subprocess orchestration.

### Modified Capabilities
- None.

## Impact

- Affected code: `apps/desktop/main.ts`, `apps/desktop/preload.ts`, `apps/desktop/renderer/App.tsx`, `apps/desktop/renderer/styles.css`, and new renderer emulator support files.
- Affected shared contracts: `packages/shared-ipc/src/contracts.ts` (or a new protocol package if split out during implementation).
- Runtime/system impact: Electron main process now manages a long-running Python bridge subprocess and forwards emulator frame/log streams to renderer.
