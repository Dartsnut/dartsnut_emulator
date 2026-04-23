## ADDED Requirements

### Requirement: Application requires workspace root selection before agent usage
The application MUST prompt for a workspace folder at startup and SHALL require a confirmed selection before enabling agent chat interactions.

#### Scenario: User selects workspace successfully
- **WHEN** the startup folder picker returns a valid local directory
- **THEN** the system SHALL persist that folder as the active workspace root for the session

#### Scenario: User cancels workspace selection
- **WHEN** the user dismisses the folder picker without choosing a directory
- **THEN** the system MUST keep agent interaction controls disabled until a workspace is selected

### Requirement: Workspace policy is applied to all session file operations
All agent file operations MUST be validated against the currently selected workspace root before execution.

#### Scenario: Operation path resolves inside workspace
- **WHEN** an agent operation targets a normalized path inside the active workspace root
- **THEN** the system SHALL allow the operation

#### Scenario: Operation path resolves outside workspace
- **WHEN** an agent operation targets a path outside the active workspace root
- **THEN** the system MUST reject the operation and return a policy error
