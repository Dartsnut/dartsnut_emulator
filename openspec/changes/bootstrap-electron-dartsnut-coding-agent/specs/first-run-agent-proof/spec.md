## ADDED Requirements

### Requirement: First-run flow demonstrates successful agent interaction
The application MUST provide a first-run path where users complete setup and execute at least one successful chat interaction with the embedded agent.

#### Scenario: First-time user completes setup and sends first message
- **WHEN** a user configures provider settings, selects workspace root, and submits an initial chat prompt
- **THEN** the system SHALL execute the prompt and return an agent response in the chat timeline

#### Scenario: Setup prerequisite missing during first-run proof
- **WHEN** required first-run setup data is incomplete
- **THEN** the system MUST prevent proof execution and direct the user to the missing setup step

### Requirement: First-run status reflects proof completion
The system SHALL persist a first-run proof completion state after at least one successful end-to-end chat turn.

#### Scenario: Proof interaction succeeds
- **WHEN** the first successful chat turn completes
- **THEN** the application MUST mark proof completion for the active installation profile

#### Scenario: Proof interaction fails
- **WHEN** the first attempted proof interaction returns an unrecoverable error
- **THEN** the application SHALL keep proof status incomplete and surface retry guidance
