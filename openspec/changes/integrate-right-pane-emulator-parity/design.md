## Context

The desktop app currently uses a left-anchored chat rail and intentionally leaves the right side empty. A separate repository already contains a working emulator implementation with renderer UI, preload bridge APIs, Electron IPC handlers, and Python subprocess orchestration for state/frame/log streaming.

This change consolidates that functionality into the current desktop app so users can keep the existing agent workflow while interacting with the emulator in the same window. The integration touches renderer layout, shared IPC contracts, preload exposure, and Electron main-process runtime behavior.

## Goals / Non-Goals

**Goals:**
- Replace the right blank area with a full-featured emulator pane equivalent to the existing emulator implementation.
- Preserve current left-side chat and workspace flow without functional regression.
- Add IPC and preload APIs for emulator command/state/frame/log exchange.
- Add Python bridge process lifecycle support in main process, including startup, reconnect behavior, stream forwarding, and graceful shutdown.
- Keep implementation dependency-light and aligned with existing Electron + React + TypeScript stack.

**Non-Goals:**
- Rewriting agent-runtime orchestration, provider logic, or chat event contracts unrelated to emulator integration.
- Creating a reduced emulator MVP; this change targets full parity.
- Re-architecting the emulator backend protocol beyond what is needed to integrate into existing desktop codebase.

## Decisions

1. **Introduce a dedicated emulator panel component in renderer**
   - The right pane will be implemented as a dedicated component and helper files (including frame worker) rather than folding all logic into the existing `App.tsx`.
   - Rationale: keeps chat code stable and limits regression blast radius.
   - Alternative considered: direct copy into `App.tsx`; rejected due to maintainability and review complexity.

2. **Extend shared desktop IPC contracts with emulator channels/types**
   - Emulator channel names and payload types will be represented in shared contracts so preload, main, and renderer use one typed source of truth.
   - Rationale: prevents drift and keeps API boundaries explicit.
   - Alternative considered: duplicating emulator types inside preload/main/renderer; rejected due to brittle type skew risk.

3. **Main process owns Python bridge lifecycle**
   - Electron main process will resolve Python executable, start the bridge, forward state/frame/log events, and terminate bridge on app shutdown.
   - Rationale: privileged process ownership and existing architecture consistency.
   - Alternative considered: spawning Python from renderer; rejected for security/isolation and lifecycle reliability concerns.

4. **Preserve current left-side behavior and attach emulator only to right side**
   - Existing left rail behavior remains functionally unchanged while layout and styles are extended to support a populated right pane.
   - Rationale: isolates risk to emulator integration and avoids scope creep into chat redesign.
   - Alternative considered: broad visual redesign while integrating emulator; rejected to keep this change focused on functional parity.

## Risks / Trade-offs

- **Frame/log event throughput can affect UI responsiveness** -> Mitigation: keep worker-based frame decode path and bounded log list behavior.
- **Contract mismatch between imported emulator behaviors and current IPC stack** -> Mitigation: centralize all emulator contracts in shared types and update preload/main/renderer together.
- **Python environment variability across machines** -> Mitigation: preserve executable resolution/probe behavior and show explicit status errors in UI state.
- **Layout/CSS collisions with existing left-rail styling** -> Mitigation: isolate emulator styles under panel-scoped class names and validate desktop window breakpoints.

## Migration Plan

1. Add emulator contracts/channels to shared IPC package (or create protocol package and wire consumers).
2. Extend preload API with emulator command/query/subscribe methods.
3. Port main-process bridge lifecycle + IPC handlers for emulator commands, path picking, background loading, and event forwarding.
4. Add renderer emulator panel component, frame worker, and styles; replace right blank pane with emulator panel mount.
5. Validate full parity behaviors manually: open path, reload, params apply, dart input, zoom, logs drawer, capture, and keyboard controls.
6. Rollback strategy: revert this change’s desktop/preload/shared-contract files to return to the previous blank-right-pane behavior.

## Open Questions

- Should emulator protocol types live in `packages/shared-ipc` or be split into a dedicated protocol package for long-term separation?
- Should bridge startup occur eagerly at app startup or lazily on first emulator interaction for lower idle overhead?
