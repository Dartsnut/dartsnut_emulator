## ADDED Requirements

### Requirement: File edits are shown as diffs in chat
The chat UI SHALL render file-write action results as diff-oriented output instead of full rewritten file bodies.

#### Scenario: Write action contains file content changes
- **WHEN** an agent action includes a file modification payload with new file content
- **THEN** the chat renders a diff block with added, removed, and context lines
- **AND** the full rewritten file body is not shown as the primary output

### Requirement: In-progress file output uses rolling preview
While the agent is still sending file content for a write action, the chat UI SHALL show a rolling preview of the last few lines so the user can see active progress.

#### Scenario: Agent is streaming file content
- **WHEN** a file-write action payload is still being received and not finalized
- **THEN** the UI shows a rolling window containing only the most recent lines from the in-progress content
- **AND** earlier lines are discarded from the preview window as new lines arrive

#### Scenario: Agent completes file-write action
- **WHEN** the file-write action payload is finalized
- **THEN** the UI replaces the rolling preview with the final diff-oriented view
- **AND** the rolling preview is no longer displayed for that completed action

### Requirement: Diff output remains readable for large changes
The chat UI SHALL constrain large diff output to preserve transcript readability.

#### Scenario: Diff exceeds display threshold
- **WHEN** a generated diff exceeds the configured maximum rendered lines
- **THEN** the UI truncates additional lines
- **AND** the UI displays an indicator that output was truncated

### Requirement: Fallback rendering preserves visibility
The chat UI SHALL preserve action visibility when diff rendering cannot be produced.

#### Scenario: Diff generation fails or lacks source context
- **WHEN** the renderer cannot compute a diff from the action payload
- **THEN** the UI falls back to the existing structured action rendering path
- **AND** the user still sees tool, path, and available content details
