## ADDED Requirements

### Requirement: Desktop app SHALL render a functional emulator pane on the right side
The desktop renderer SHALL replace the existing right blank area with an emulator pane that is visible within the same window as the current chat UI.

#### Scenario: Right pane is populated by emulator panel
- **WHEN** the desktop app renderer loads successfully
- **THEN** the right side SHALL show emulator UI instead of an empty placeholder

#### Scenario: Left chat workflow remains available
- **WHEN** the emulator pane is present
- **THEN** the existing left-side chat and workspace controls SHALL remain usable

### Requirement: Renderer SHALL support full emulator interaction parity
The emulator pane SHALL support parity controls including widget open/reload, widget params JSON edit/apply, dart throw/remove/clear interaction, keyboard input mapping, screenshot capture feedback, zoom view, and logs drawer controls.

#### Scenario: Widget lifecycle controls
- **WHEN** a user selects a widget path and triggers reload
- **THEN** the renderer SHALL send the corresponding emulator commands and update visible state feedback

#### Scenario: Dart interaction controls
- **WHEN** a user uses mouse/keyboard controls for dart placement or removal
- **THEN** the renderer SHALL translate input into emulator commands with correct payload coordinates and indices

#### Scenario: Logs and zoom tools
- **WHEN** a user opens zoom or logs drawer controls
- **THEN** the renderer SHALL show live frame/log-derived UI with parity actions (open/close, pause/resume logs, clear logs)

### Requirement: Desktop preload and IPC contracts SHALL expose emulator interfaces
The desktop preload bridge SHALL expose typed emulator APIs for command invocation, path/background queries, and subscriptions to emulator state, frame, and log streams.

#### Scenario: Renderer subscribes to emulator events
- **WHEN** renderer registers emulator event listeners through preload APIs
- **THEN** the preload/main contract SHALL deliver typed state, frame, and log payloads over defined IPC channels

#### Scenario: Renderer invokes emulator commands
- **WHEN** renderer invokes an emulator command through preload
- **THEN** main process SHALL receive the command on the mapped channel and return an invocation result

### Requirement: Main process SHALL manage Python bridge lifecycle for emulator runtime
Electron main process SHALL resolve a usable Python executable, start the bridge subprocess, forward bridge events to renderer channels, and shut down bridge process during app exit.

#### Scenario: Bridge startup and state propagation
- **WHEN** the app starts (or bridge is lazily initialized per design decision)
- **THEN** main process SHALL launch bridge service and publish bridge/emulator state updates to renderer subscribers

#### Scenario: Bridge failure handling
- **WHEN** bridge process errors or exits unexpectedly
- **THEN** main process SHALL update emulator status to indicate failure and keep command handling behavior deterministic (restart or error response path)

#### Scenario: Graceful shutdown
- **WHEN** the app is quitting
- **THEN** main process SHALL terminate the active bridge subprocess to avoid orphaned Python processes
