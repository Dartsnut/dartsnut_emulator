## Context

The creation flow currently assumes key inputs (project type, workspace readiness, and widget dimensions) are either implicit or already available. In no-workspace sessions this causes ambiguity and late failures. This change introduces an explicit intake gate before invoking creation templates so the downstream game/widget generator receives complete, validated context.

## Goals / Non-Goals

**Goals:**
- Collect project type when not explicitly stated, constrained to `game` or `widget`.
- Collect widget size when project type is `widget`, constrained to `128x160`, `128x128`, `128x64`, or `64x32`.
- Require workspace folder selection before generation and reject non-empty folders with a reprompt.
- Route to a templated creator skill (`game-creator` or `widget-creator`) only after prerequisites are satisfied.
- Keep prompts deterministic so the same missing inputs yield the same prompt order.

**Non-Goals:**
- Redesign existing game/widget generator internals.
- Add new widget sizes beyond the four approved dimensions.
- Support "create in non-empty folder" override behavior in this change.

## Decisions

1. **Use a strict intake state machine before template invocation**
   - **Decision:** Implement the flow as ordered checkpoints: determine type -> determine widget size (conditional) -> choose workspace -> validate emptiness -> route template.
   - **Rationale:** A linear state machine prevents skipping critical fields and makes behavior testable.
   - **Alternative considered:** Free-form prompt handling with ad-hoc checks. Rejected because it is harder to verify and maintain.

2. **Validate folder emptiness as a hard precondition**
   - **Decision:** Treat non-empty selected folders as invalid and require user to choose a different folder.
   - **Rationale:** Prevents accidental file collisions and keeps generated projects reproducible.
   - **Alternative considered:** Allow generation into non-empty folders with warnings. Rejected due to higher overwrite/conflict risk.

3. **Normalize project intent into a shared context payload**
   - **Decision:** Build a normalized payload (`type`, `widgetSize?`, `workspacePath`) and pass it into the chosen creator skill.
   - **Rationale:** Simplifies the interface between intake and generators and avoids duplicated parsing in creator templates.
   - **Alternative considered:** Let each creator skill re-ask for missing context. Rejected because it duplicates logic and may diverge.

4. **Constrain widget size selection to fixed choices**
   - **Decision:** Require explicit size selection from the four supported options and block free-form values.
   - **Rationale:** Keeps output compatible with supported templates and target device constraints.
   - **Alternative considered:** Accept arbitrary dimensions and coerce to nearest supported value. Rejected due to surprising behavior.

## Risks / Trade-offs

- **[Risk] Increased prompt friction for users who prefer one-shot prompts** -> **Mitigation:** Skip prompts for fields already present in the initial request; only ask for missing values.
- **[Risk] False negatives on folder emptiness checks due to hidden/system files** -> **Mitigation:** Define emptiness check semantics clearly (any file/dir counts as non-empty) and communicate the reason when rejecting.
- **[Risk] Routing mismatch if user intent is ambiguous** -> **Mitigation:** Use explicit project-type confirmation before advancing.

## Migration Plan

1. Implement intake orchestration and folder validation behavior behind the existing creation entrypoint.
2. Wire routing to the game/widget templated creator skills with normalized context.
3. Add tests for each intake branch (provided type, missing type, widget sizes, non-empty folder rejection, successful routing).
4. Roll out by enabling the new intake path as default once tests pass.

Rollback strategy: revert to the previous direct routing path by disabling the intake gate in the entrypoint.

## Open Questions

- Should the folder emptiness check ignore known metadata files (for example `.DS_Store`) or remain strict?
- Should the selected workspace path persist across sessions when creation fails mid-flow?
