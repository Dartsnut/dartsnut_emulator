## Why

The current desktop UI feels utilitarian and the chat transcript is hard to scan during longer sessions. A focused visual restyle will improve readability and perceived quality while preserving current agent behavior.

## What Changes

- Restyle the desktop app shell so the primary app content is anchored on the left and the right side remains intentionally empty.
- Redesign chat transcript message cards to match a Cursor-like conversation look-and-feel with clearer separation between user, agent, status, and error entries.
- Improve chat payload readability by presenting agent narrative text and structured action content in consistently formatted sections.
- Refine spacing, typography, and surfaces in the main setup panel and composer for a more modern and consistent interface.

## Capabilities

### New Capabilities
- `desktop-chat-ui-restyle`: Provide a left-anchored desktop layout and Cursor-inspired chat message styling for the embedded agent UI.

### Modified Capabilities
- None.

## Impact

- Affected code: `apps/desktop/renderer/App.tsx`, `apps/desktop/renderer/styles.css`.
- No API contract changes for IPC channels or runtime provider interfaces.
- No new dependencies are required.
