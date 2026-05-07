## ADDED Requirements

### Requirement: Collect project type before creation
The agent MUST determine the project type as `game` or `widget` before invoking any creator template when no workspace is preselected.

#### Scenario: Project type provided in initial request
- **WHEN** the user request explicitly indicates `game` or `widget`
- **THEN** the agent SHALL use that type without prompting for project type

#### Scenario: Project type missing from initial request
- **WHEN** the user request does not indicate whether they want a game or a widget
- **THEN** the agent SHALL prompt the user to choose exactly one of `game` or `widget` before continuing

### Requirement: Validate workspace selection as empty
The agent MUST require a workspace folder selection and MUST reject folders that are not empty.

#### Scenario: No workspace selected
- **WHEN** the creation flow reaches workspace validation and no folder is selected
- **THEN** the agent SHALL prompt the user to select a workspace folder path

#### Scenario: Selected folder is not empty
- **WHEN** the user selects a folder that contains any files or subdirectories
- **THEN** the agent SHALL reject the selection and prompt the user to choose a different folder

#### Scenario: Selected folder is empty
- **WHEN** the user selects a folder with no files or subdirectories
- **THEN** the agent SHALL accept the folder and continue to template routing

### Requirement: Route to creator template after prerequisites
The agent MUST route to the correct templated creator workflow only after all required inputs are resolved.

#### Scenario: Route to game creator
- **WHEN** project type is `game` and workspace selection is validated
- **THEN** the agent SHALL invoke the game-creator template with normalized creation context

#### Scenario: Route to widget creator
- **WHEN** project type is `widget`, widget size is resolved, and workspace selection is validated
- **THEN** the agent SHALL invoke the widget-creator template with normalized creation context
