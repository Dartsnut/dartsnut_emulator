## Why

Users need a consistent way to configure their own LLM provider settings at runtime without editing environment files. Adding a keyboard-accessible settings screen now enables per-user endpoint, API key, and model control across platforms.

## What Changes

- Add a global keyboard shortcut to open a settings screen from the main view (`Cmd+,` on macOS, `Ctrl+,` on Windows/Linux).
- Make the settings screen replace the main view while it is active.
- Add a settings menu with one item: OpenAI key configuration.
- In the OpenAI key configuration panel, allow users to input and save:
  - API endpoint
  - API key
  - model name
- Update LLM call configuration resolution so user-saved values override default `.env` values when present.
- Keep existing `.env` defaults as fallback when user settings are missing or incomplete.

## Capabilities

### New Capabilities

- `settings-screen-navigation`: Open and display the settings screen via cross-platform shortcut and settings menu navigation.
- `openai-runtime-configuration`: Capture, persist, and apply user-provided OpenAI endpoint/key/model values for runtime LLM calls.

### Modified Capabilities

- None.

## Impact

- Affected code includes keyboard shortcut handling, view routing/state, settings UI components, and LLM client configuration loading.
- No external API contract changes; behavior changes are internal to runtime configuration precedence.
- Requires secure local persistence for user-provided API key and related configuration values.
