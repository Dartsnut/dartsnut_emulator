## ADDED Requirements

### Requirement: Chat UI displays user and agent timeline entries
The desktop chat interface SHALL render each user message and each agent response as ordered timeline entries in the active session view.

#### Scenario: User sends a prompt
- **WHEN** the user submits a chat message
- **THEN** the UI MUST show the message in the timeline before agent processing completes

#### Scenario: Agent returns final response
- **WHEN** the embedded agent completes a turn
- **THEN** the UI SHALL append the agent response in the same session timeline

### Requirement: Chat UI surfaces live agent activity
The chat interface MUST display structured agent activity updates, including in-progress operations and completion states.

#### Scenario: Agent is running tool actions
- **WHEN** the agent emits progress events during a turn
- **THEN** the UI SHALL show live status updates that indicate what the agent is currently doing

#### Scenario: Agent operation fails
- **WHEN** an agent action returns an error
- **THEN** the UI MUST present an error state and preserve preceding activity context
