## ADDED Requirements

### Requirement: User can configure OpenAI endpoint, API key, and model
The system MUST allow users to input and save OpenAI API endpoint, API key, and model values from the settings screen.

#### Scenario: Save complete OpenAI configuration
- **WHEN** the user enters endpoint, API key, and model values and confirms save
- **THEN** the system persists all three values in user settings storage

#### Scenario: Edit existing OpenAI configuration
- **WHEN** saved OpenAI configuration exists and the user updates one or more fields
- **THEN** the system persists the updated values
- **AND** subsequent reads return the latest saved values

### Requirement: LLM runtime configuration prioritizes user settings over environment defaults
The system MUST use user-saved OpenAI configuration values for LLM calls when present, and MUST fall back to `.env` defaults for any missing values.

#### Scenario: User configuration fully overrides defaults
- **WHEN** user settings contain endpoint, API key, and model values
- **THEN** LLM calls use those user settings values instead of `.env` defaults

#### Scenario: Missing user fields fall back to `.env`
- **WHEN** user settings are missing one or more OpenAI fields
- **THEN** LLM calls use user settings for present fields
- **AND** use `.env` defaults for missing fields

### Requirement: Invalid configuration is rejected before persistence
The system MUST validate OpenAI configuration inputs before saving and MUST reject invalid values with user-visible feedback.

#### Scenario: Reject empty required fields
- **WHEN** the user attempts to save with an empty API key or empty model
- **THEN** the system does not persist the configuration
- **AND** shows validation feedback indicating required fields

#### Scenario: Reject invalid endpoint URL format
- **WHEN** the user enters a non-empty endpoint that is not a parseable URL and attempts to save
- **THEN** the system does not persist the configuration
- **AND** shows validation feedback for endpoint format
