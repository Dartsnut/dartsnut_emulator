## Context

`packages/agent-runtime/skills/game-creator.md` currently provides only high-level guidance and lacks enforceable structure for game generation. In contrast, `widget-creator.md` includes concrete contracts, required outputs, follow-up handling, and implementation patterns that reduce ambiguity.

A review of all game folders in `../python_games` with `conf.json` shows stable conventions:
- all 26 game `conf.json` files include `id`, `type`, `name`, `author`, `version`, `description`, `size`, `fields`, and `preview`
- most games are `pygame`-based and frequently integrate with `pydartsnut.Dartsnut` for hit/button input and frame-buffer output
- common runtime pattern is a main loop with event handling, update/render separation, and `engine.update_frame_buffer(...)` using transposed screen arrays

The change updates only skill guidance text, but it is cross-cutting in effect because generated code quality depends on this template.

## Goals / Non-Goals

**Goals:**
- Define a robust `game-creator` template with stronger structure than the current version.
- Encode evidence-backed best practices from the existing game corpus.
- Specify library choice rules (`pygame` baseline, `pydartsnut` integration when targeting emulator/runtime APIs).
- Add a mandatory game `conf.json` contract and defaults aligned with existing games.
- Provide reusable code snippets and architectural dos/don'ts for both first-generation and follow-up edits.

**Non-Goals:**
- Refactor or rewrite existing game implementations under `../python_games`.
- Introduce new runtime features in `pydartsnut` or emulator code.
- Enforce static linting/validation tooling for generated skill output in this change.
- Redesign widget behavior; `widget-creator.md` remains reference only.

## Decisions

- **Decision: Keep one authoritative game template in `packages/agent-runtime/skills/game-creator.md`.**
  - Rationale: The runtime consumes this skill directly; centralizing avoids divergence.
  - Alternative considered: Splitting into multiple game sub-skills. Rejected because it increases maintenance cost and prompt selection ambiguity.

- **Decision: Add explicit generation contract sections mirroring `widget-creator` style (process, required outputs, contract, patterns, follow-up behavior).**
  - Rationale: Widget template structure has proven reliable; game generation needs even more guardrails due to higher complexity.
  - Alternative considered: Keep free-form narrative guidance. Rejected because it repeats current ambiguity.

- **Decision: Standardize `conf.json` requirements from observed corpus rather than inventing a new schema.**
  - Rationale: Existing games already demonstrate a de facto contract used by tooling and runtime.
  - Alternative considered: Minimal `conf.json` (id/name only). Rejected because it causes downstream metadata and preview inconsistencies.

- **Decision: Provide practical snippets for the emulator loop and frame buffer handoff.**
  - Rationale: The most common implementation failures are loop shape and framebuffer orientation; snippets reduce these errors.
  - Alternative considered: Describe in prose only. Rejected because prose is less copy-safe for generation agents.

- **Decision: Include explicit dos/don'ts and follow-up edit rules.**
  - Rationale: Generated projects often receive iterative requests; treating small tweaks as edits prevents destructive re-scaffolding.
  - Alternative considered: No follow-up policy. Rejected due to repeated churn in iterative workflows.

## Risks / Trade-offs

- **Risk: Over-constraining creativity for unusual games** → Mitigation: keep required contract minimal and allow justified deviations when user intent conflicts.
- **Risk: Guidance drift as game corpus evolves** → Mitigation: document corpus-derived assumptions and require periodic re-audit.
- **Risk: Snippet misuse in non-emulator contexts** → Mitigation: include decision rules for local-only `pygame` loop vs `pydartsnut` integration loop.
- **Trade-off: Longer skill file increases upfront reading cost** → Benefit: fewer runtime/integration errors and fewer corrective turns.
