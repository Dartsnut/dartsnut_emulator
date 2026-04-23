## Why

Displaying full rewritten file contents in chat makes responses noisy and hard to review, especially for large files. Showing concise diffs instead improves readability and aligns with developer expectations for change review.

## What Changes

- Change chat rendering so file edit actions show a diff-style preview instead of full post-edit file content.
- Introduce a renderer path for structured file change payloads that computes and displays added/removed/unchanged context lines.
- Keep a safe fallback to current plain-text rendering when diff data is unavailable or malformed.
- Preserve existing typed response behavior and action metadata display.

## Capabilities

### New Capabilities
- `chat-file-change-diff-display`: Render file modification results in chat as concise diffs instead of full file contents.

### Modified Capabilities
- None.

## Impact

- Affected code: `apps/desktop/renderer/App.tsx`, `apps/desktop/renderer/styles.css` and possibly agent payload formatting helpers in renderer.
- No IPC or provider API changes required.
- No new external dependencies required if a lightweight in-app diff formatter is used.
