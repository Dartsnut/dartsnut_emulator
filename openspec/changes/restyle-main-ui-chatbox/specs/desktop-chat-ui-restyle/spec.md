## ADDED Requirements

### Requirement: Left-anchored desktop layout
The desktop renderer SHALL present the main application interface in a left-side content rail and preserve empty visual space on the right side of the window.

#### Scenario: Main shell renders in left rail
- **WHEN** the desktop app is opened
- **THEN** the primary setup, timeline, and composer sections appear in a bounded left-side layout column
- **AND** the right side remains intentionally unused for content

### Requirement: Cursor-like message card styling
The chat timeline SHALL style user, agent, status, and error messages as distinct card variants with consistent spacing and typography.

#### Scenario: Role-based styles are applied
- **WHEN** timeline entries are rendered
- **THEN** each entry role uses a distinct visual treatment for background and borders
- **AND** transcript content remains readable in long sessions

### Requirement: Structured agent payload presentation
The renderer SHALL display agent responses that contain structured action payloads in formatted sections that include narrative text, response summary, and per-action details.

#### Scenario: Agent message includes narrative and actions
- **WHEN** an agent message contains both human-readable text and a JSON action envelope
- **THEN** the UI extracts and renders narrative text separately from action details
- **AND** each action section shows tool identity, target path when provided, and formatted content body
