## ADDED Requirements

### Requirement: Agent session uses user-provided OpenAI-compatible provider settings
The application MUST allow users to configure an OpenAI-compatible `baseUrl`, `apiKey`, and model, and SHALL use those values when creating agent sessions.

#### Scenario: Valid provider configuration starts a session
- **WHEN** the user provides valid provider settings and starts a chat session
- **THEN** the system initializes the embedded coding agent using the configured endpoint and model

#### Scenario: Invalid provider configuration is rejected
- **WHEN** provider settings fail validation or connection checks
- **THEN** the system MUST block session start and show an actionable setup error

### Requirement: Agent runtime supports filesystem-scoped code operations
The agent runtime MUST expose code-generation and file-editing operations while enforcing workspace root boundaries defined by the application.

#### Scenario: Agent writes file inside workspace root
- **WHEN** the agent requests a file write within the selected workspace root
- **THEN** the system SHALL execute the write operation and emit a corresponding progress event

#### Scenario: Agent attempts write outside workspace root
- **WHEN** the agent requests a file write outside the selected workspace root
- **THEN** the system MUST reject the operation and record a policy violation event
