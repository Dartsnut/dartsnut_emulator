## Why

The current `game-creator` template is too shallow for reliable game generation and does not encode the real patterns used across the `python_games` corpus. We need a stronger template now so generated games consistently match runtime expectations (`pydartsnut`, `pygame`, frame-buffer updates, and `conf.json` structure) and avoid common failure modes.

## What Changes

- Audit all game projects in `../python_games` (26 folders with `conf.json`) and extract repeatable generation guidance.
- Expand `packages/agent-runtime/skills/game-creator.md` with a structured workflow similar to `widget-creator.md`, but game-specific and more comprehensive.
- Add explicit `conf.json` generation contract for games (required keys, expected formats, and defaults).
- Add common code snippets for runtime loop, `Dartsnut` integration, and frame-buffer syncing.
- Add concrete dos and don'ts for library choices, architecture boundaries, and follow-up edit behavior.
- Add guidance for when to use `pygame` only vs `pygame + pydartsnut` hybrid runtime.

## Capabilities

### New Capabilities
- `templated-game-creator-guidance`: Define a comprehensive, evidence-based game-creator skill template that captures library selection, configuration generation, runtime integration snippets, and authoring guardrails from existing games.

### Modified Capabilities
- None.

## Impact

- Affected code: `packages/agent-runtime/skills/game-creator.md`
- Reference source for guidance: `../python_games/**` and `packages/agent-runtime/skills/widget-creator.md`
- No API-breaking changes expected; this is a prompt/skill quality and consistency improvement.
- Expected downstream impact: higher success rate and lower rework for generated game projects.
