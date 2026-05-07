## Why

When users start with no selected workspace folder, the agent lacks required context to generate a valid project and can produce incorrect or incomplete outputs. We need a deterministic onboarding sequence that gathers project type, widget size (when applicable), and a valid empty workspace before running creator templates.

## What Changes

- Add a mandatory pre-creation intake flow when no workspace folder is selected.
- Require explicit project type selection (`game` or `widget`) if not provided in the initial request.
- For widget flows, require explicit size selection from supported dimensions: `128x160`, `128x128`, `128x64`, `64x32`.
- Require users to select a workspace folder path and validate emptiness before project creation; if non-empty, prompt for a different folder.
- Route creation to one of two templated creator skills (`game-creator` or `widget-creator`) once all required inputs are collected.

## Capabilities

### New Capabilities
- `project-intake-and-routing`: Collect required creation inputs (type, size, workspace), validate folder state, and route to the matching creator template.
- `widget-size-selection`: Enforce supported widget size choices and pass normalized size context into widget creation.

### Modified Capabilities
- None.

## Impact

- Affected systems: agent onboarding flow, workspace selection flow, project creation routing.
- Affected artifacts: new behavior specs for intake/routing and widget-size constraints.
- User impact: fewer ambiguous creation attempts, predictable project scaffolding, and explicit recovery when selected folders are not empty.
