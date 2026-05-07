## ADDED Requirements

### Requirement: Restrict widget size to supported dimensions
For widget creation, the agent MUST collect and enforce one supported widget size from `128x160`, `128x128`, `128x64`, or `64x32`.

#### Scenario: Size provided and supported
- **WHEN** the user request specifies one of `128x160`, `128x128`, `128x64`, or `64x32`
- **THEN** the agent SHALL accept that size and proceed without asking for size again

#### Scenario: Size missing for widget request
- **WHEN** the user requests widget creation without a size
- **THEN** the agent SHALL prompt the user to choose one supported size option before creation continues

#### Scenario: Size provided but unsupported
- **WHEN** the user provides a widget size outside the supported set
- **THEN** the agent SHALL reject that value and prompt the user to select one supported size option

### Requirement: Pass normalized widget size to template execution
The agent MUST pass the selected supported size as normalized context to the widget-creator template.

#### Scenario: Widget template receives size
- **WHEN** the widget creation flow reaches template routing
- **THEN** the agent SHALL include the selected size value unchanged in the context payload delivered to widget-creator
