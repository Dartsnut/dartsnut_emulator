## Context

The desktop renderer currently uses a centered container with basic card styling. Chat entries are readable for short sessions but become noisy when responses include both human narrative and structured action payloads. The requested direction is a Cursor-like chat presentation while preserving existing event flow and typed response behavior.

Constraints:
- Keep IPC and runtime behavior unchanged.
- Keep the right side of the window intentionally empty.
- Implement within the existing React + CSS stack without adding dependencies.

## Goals / Non-Goals

**Goals:**
- Shift the main application shell to a left-column layout with reserved whitespace on the right.
- Introduce message-card styling patterns that visually separate user/agent/system/error entries.
- Present structured agent payload content in a consistent, readable format.
- Maintain current send/receive behavior, including the typed-out effect.

**Non-Goals:**
- Rewriting event contracts or session-engine logic.
- Adding markdown rendering libraries or syntax-highlighting packages.
- Implementing virtualization or pagination for the timeline.

## Decisions

1. **Two-column shell with fixed content rail on the left**
   - Implement main UI as a bounded left rail and leave a flexible right column empty.
   - Rationale: directly satisfies the “left side only” requirement and improves visual focus.
   - Alternative considered: keep centered single column with larger max width; rejected because it does not preserve intentional right-side empty space.

2. **Role-specific chat cards with Cursor-inspired surfaces**
   - Use distinct background, border, and spacing tokens per role (`user`, `agent`, `status`, `error`) while keeping typography consistent.
   - Rationale: faster transcript scanning and visual parity with modern coding-assistant UIs.
   - Alternative considered: single style with colored labels only; rejected due to weaker visual grouping.

3. **Structured action rendering from parsed JSON payload**
   - Parse trailing JSON envelopes from agent text and render sections (`response`, action metadata, and `content`) in dedicated blocks.
   - Rationale: keeps actual content visible while avoiding unreadable raw inline JSON dumps.
   - Alternative considered: always show raw JSON only; rejected due to poor readability for long file contents.

4. **Pure CSS implementation**
   - Keep styling in `styles.css` using existing classnames and minimal component changes.
   - Rationale: smallest maintenance overhead and no dependency churn.
   - Alternative considered: CSS-in-JS migration; rejected as unnecessary scope expansion.

## Risks / Trade-offs

- **[Very long action content can dominate timeline]** → Mitigation: keep monospaced blocks with wrapping and allow future collapsible sections if needed.
- **[Cursor-like style interpretation may differ from user expectation]** → Mitigation: preserve semantic structure so visual tokens can be quickly tuned in follow-up.
- **[More complex message parser may mis-detect malformed JSON]** → Mitigation: keep safe fallback to plain-text rendering when parsing fails.

## Migration Plan

1. Update renderer layout structure and chat entry component rendering.
2. Update CSS tokens/classes for left-rail layout and message-card presentation.
3. Verify with desktop build and manual transcript checks for:
   - plain text responses,
   - mixed narrative + JSON responses,
   - status and error events.
4. Rollback strategy: revert `App.tsx` and `styles.css` to prior commit if visual regressions are found.

## Open Questions

- Should action `content` blocks be collapsed by default for large file writes?
- Do we want a compact-density toggle for smaller laptop screens?
