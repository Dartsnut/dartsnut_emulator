## 1. Shared Contracts and Bridge Surface

- [ ] 1.1 Add emulator IPC channels and payload types to shared contracts for commands, state, frames, logs, path selection, and background loading.
- [ ] 1.2 Extend desktop preload bridge API to expose emulator invoke/query/subscribe methods with typed signatures.
- [ ] 1.3 Update renderer global type declarations to include the emulator bridge surface and event callback types.

## 2. Main Process Emulator Runtime Integration

- [ ] 2.1 Port Python executable resolution and bridge startup logic into desktop main process with explicit status signaling.
- [ ] 2.2 Add emulator IPC handlers for command dispatch, widget path selection, last-path lookup, and background image retrieval.
- [ ] 2.3 Implement bridge stdout/stderr parsing and forward typed emulator state/frame/log events to renderer channels.
- [ ] 2.4 Ensure lifecycle cleanup terminates the bridge process on app quit and handles unexpected bridge exit/error paths deterministically.

## 3. Renderer Right-Pane Emulator UI Parity

- [ ] 3.1 Replace the right blank pane with a dedicated emulator panel mount while preserving existing left-side chat behavior.
- [ ] 3.2 Add emulator panel component and helper logic for state subscriptions, chat-independent controls, and command dispatch.
- [ ] 3.3 Port frame worker decode/render pipeline (including background/grid composition and FPS metrics) for emulator canvas updates.
- [ ] 3.4 Implement parity interactions: widget open/reload, params JSON format/apply, dart keyboard/mouse controls, screenshot feedback, zoom popover, and logs drawer controls.
- [ ] 3.5 Port and scope emulator styles so right-pane layout and controls match functional parity without regressing left-rail layout.

## 4. Verification and Readiness

- [ ] 4.1 Run desktop typecheck/build to validate contract alignment across main/preload/renderer.
- [ ] 4.2 Perform manual parity validation in Electron: open path, reload widget, params apply, dart interactions, zoom, logs, and screenshot capture.
- [ ] 4.3 Confirm no regressions in existing left-side chat/workspace flow and document any known follow-up limitations.
