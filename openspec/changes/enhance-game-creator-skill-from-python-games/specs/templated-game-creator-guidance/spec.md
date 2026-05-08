## ADDED Requirements

### Requirement: Game creator template SHALL define a strict output contract
The `game-creator` skill template SHALL define mandatory outputs and baseline project shape for generated game projects, including required code entrypoint(s), metadata configuration, and run instructions.

#### Scenario: New game generation request
- **WHEN** an agent uses the `game-creator` skill to create a game from a new request
- **THEN** the skill guidance includes a deterministic process, mandatory output list, and scope constraints instead of only high-level advice

### Requirement: Game creator template SHALL define `conf.json` generation rules
The `game-creator` skill template SHALL require generation of `conf.json` with top-level keys `id`, `type`, `name`, `author`, `version`, `description`, `size`, `fields`, and `preview`, and SHALL define default handling for missing user inputs while preserving requested values.

#### Scenario: Missing optional metadata in user request
- **WHEN** the user request omits parts of metadata such as version or description
- **THEN** the generated guidance specifies safe defaults while still producing a valid `conf.json` contract-compliant file

### Requirement: Game creator template SHALL provide library and runtime integration guidance
The template SHALL include explicit rules for selecting libraries and runtime integration paths, including when to use `pygame` only and when to integrate `pydartsnut.Dartsnut` for dart/button inputs and frame-buffer updates.

#### Scenario: Emulator-targeted game request
- **WHEN** a request targets Dartsnut/emulator behavior
- **THEN** the template guidance directs use of `pydartsnut.Dartsnut` with a runtime loop that reads input events and pushes frames via `update_frame_buffer`

### Requirement: Game creator template SHALL include common code snippets and architecture guardrails
The template SHALL include reusable snippets or pseudocode for main loop structure, update/render split, and frame-buffer handoff, and SHALL include explicit dos/don'ts that prevent known failure patterns (e.g., missing loop control, absent framebuffer sync, unnecessary re-scaffolding on tweak requests).

#### Scenario: Follow-up tweak request after initial generation
- **WHEN** a user asks for a small follow-up change (layout, speed, color, scoring tweak)
- **THEN** the template guidance instructs the agent to edit existing game files first rather than regenerate the project from scratch unless explicitly requested
