## ADDED Requirements

### Requirement: Settings screen opens via platform shortcut
The system MUST open the settings screen when the user presses `Cmd+,` on macOS or `Ctrl+,` on Windows/Linux.

#### Scenario: Open settings from main view on macOS
- **WHEN** the user is in the main view on macOS and presses `Cmd+,`
- **THEN** the system opens the settings screen
- **AND** the main view is replaced by the settings screen

#### Scenario: Open settings from main view on Windows/Linux
- **WHEN** the user is in the main view on Windows/Linux and presses `Ctrl+,`
- **THEN** the system opens the settings screen
- **AND** the main view is replaced by the settings screen

### Requirement: Settings screen provides a settings menu entry for OpenAI configuration
The settings screen MUST display a settings menu that includes an item for OpenAI key configuration.

#### Scenario: Settings menu displays OpenAI item
- **WHEN** the settings screen is rendered
- **THEN** the settings menu includes an item labeled for OpenAI key configuration

#### Scenario: Selecting OpenAI menu item shows configuration form
- **WHEN** the user selects the OpenAI key configuration menu item
- **THEN** the system displays the OpenAI configuration form panel
