## 1. Diff Rendering Foundation

- [ ] 1.1 Extend agent action formatting helpers to detect file-write actions intended for diff display.
- [ ] 1.2 Implement in-progress rolling preview logic that keeps only the last few lines of file content while agent output is still streaming.
- [ ] 1.3 Implement a lightweight line-based diff generator for old/new text payloads used after action completion.
- [ ] 1.4 Add truncation logic and marker output for large diff results.

## 2. Chat UI Presentation

- [ ] 2.1 Render a rolling “last lines” view for in-progress file-write output.
- [ ] 2.2 Replace the rolling preview with final diff blocks (added/removed/context) when action completes.
- [ ] 2.3 Preserve existing narrative, response, and metadata sections around rolling/diff views.
- [ ] 2.4 Keep fallback rendering for malformed payloads or missing diff inputs.

## 3. Styling and Verification

- [ ] 3.1 Add CSS classes for rolling preview lines, diff lines, and truncation notices with clear visual distinction.
- [ ] 3.2 Run `npm --prefix apps/desktop run build` to verify renderer and Electron compilation.
- [ ] 3.3 Manually validate chat output for in-progress rolling preview, completed diff replacement, large edits, and fallback scenarios.
