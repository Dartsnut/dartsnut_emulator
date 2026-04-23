## ADDED Requirements

### Requirement: Agent sessions load bundled Dartsnut domain skills
The system MUST package Dartsnut-focused skills and SHALL inject them into every newly started agent session.

#### Scenario: New session starts with skill bundle available
- **WHEN** the user starts a new agent session
- **THEN** the runtime MUST load the bundled Dartsnut skill set before processing the first user message

#### Scenario: Skill bundle is missing or invalid
- **WHEN** bundled skill metadata fails validation at session start
- **THEN** the system MUST block the session and show a configuration error for recovery

### Requirement: Bundled skills guide `pygame` and `pydartsnut` generation behavior
Bundled Dartsnut skills MUST provide normative guidance for generating and modifying applications that use `pygame` and `pydartsnut`.

#### Scenario: User requests a new Dartsnut app scaffold
- **WHEN** the user asks the agent to create a Dartsnut application
- **THEN** the agent output SHALL follow bundled skill guidance for required libraries and interaction patterns

#### Scenario: User requests modifications to existing Dartsnut app
- **WHEN** the user asks the agent to modify an existing project under workspace root
- **THEN** the agent output MUST remain aligned with bundled Dartsnut skill constraints
