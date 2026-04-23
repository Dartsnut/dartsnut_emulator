## Context

The current chat renderer shows entire `write_file` action payload content directly in the timeline, which is often the full updated file text. This creates very long messages that reduce readability and make it hard for users to quickly understand what changed.

The desired behavior is to keep action visibility but present edits as diff-oriented output in the chat. The work is renderer-focused and should not alter provider APIs, IPC contracts, or session-engine behavior.

## Goals / Non-Goals

**Goals:**
- Display file-edit action results as concise diff blocks rather than full file bodies.
- Preserve existing narrative text, response section, and action metadata display structure.
- Keep robust fallback rendering when a diff cannot be computed.
- Keep typed response and event flow behavior unchanged.

**Non-Goals:**
- Changing agent tool protocol contracts.
- Building a full git-style patch parser with every edge-case format.
- Adding third-party diff libraries unless absolutely necessary.

## Decisions

1. **Compute display diff in renderer for file-write actions**
   - For `write_file` actions, compare prior content (if available from payload context) and new content to generate line-based diff output.
   - If prior content is not available, render a shortened preview with “new file content” labeling.
   - Rationale: keeps implementation local to UI and avoids backend contract changes.
   - Alternative considered: require backend to send diff; rejected for tighter coupling and broader scope.

2. **Use compact line-prefix diff format in chat**
   - Render diff lines with prefixes (`+`, `-`, and context) and visual color coding per line type.
   - Include limited context windows to avoid massive payloads.
   - Rationale: familiar developer format and significantly reduced chat noise.
   - Alternative considered: side-by-side viewer; rejected due to complexity and narrow timeline width.

3. **Graceful fallback path**
   - If parsing/diff generation fails, render existing structured action block safely.
   - Rationale: no regression in visibility of action payloads.

## Risks / Trade-offs

- **[Input payload may not include old content]** → Mitigation: detect absence and show concise “new content preview” with truncation.
- **[Large files can still produce large diffs]** → Mitigation: cap rendered lines and add truncation marker.
- **[Line-based diff may miss semantic structure]** → Mitigation: keep output simple and readable rather than semantically exhaustive.

## Migration Plan

1. Extend renderer formatting helpers to classify file-write actions for diff rendering.
2. Add lightweight line-diff utility in renderer layer.
3. Add CSS classes for diff lines and truncated blocks.
4. Verify via desktop build and manual checks with mixed action payloads.
5. Rollback strategy: revert renderer formatting/styling changes if regression occurs.

## Open Questions

- Should truncated diff blocks have an explicit “expand” interaction or remain static initially?
- Do we want separate color palette tokens for added/removed/context lines beyond current theme?
