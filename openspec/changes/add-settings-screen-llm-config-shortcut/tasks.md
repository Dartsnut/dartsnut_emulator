## 1. Shortcut and view navigation

- [ ] 1.1 Add platform-aware shortcut handling for `Cmd+,` (macOS) and `Ctrl+,` (Windows/Linux) in the app-level key event flow.
- [ ] 1.2 Wire shortcut action to transition from main view state to settings screen state.
- [ ] 1.3 Ensure settings screen replaces main view while active and preserves existing navigation behavior when exiting settings.

## 2. Settings screen and menu

- [ ] 2.1 Create settings screen layout with a settings menu container and content panel.
- [ ] 2.2 Add a menu item for OpenAI key configuration and connect it to render the OpenAI settings form.
- [ ] 2.3 Add form fields for API endpoint, API key, and model with initial values loaded from persisted settings.

## 3. Persistence and validation

- [ ] 3.1 Implement save/load logic for endpoint, API key, and model in user settings storage.
- [ ] 3.2 Add input validation rules (required API key/model, parseable endpoint URL when provided) and user-visible validation errors.
- [ ] 3.3 Mask API key presentation in settings UI where values are displayed after load/save.

## 4. LLM configuration resolution

- [ ] 4.1 Refactor LLM configuration resolution to read user settings first, then fill missing values from `.env` defaults.
- [ ] 4.2 Update LLM call initialization path to use resolved runtime configuration consistently.
- [ ] 4.3 Add or update tests for precedence behavior: full override and partial fallback to `.env`.

## 5. Verification

- [ ] 5.1 Add/update tests for shortcut behavior on macOS vs Windows/Linux modifier mapping.
- [ ] 5.2 Add/update tests for settings menu rendering and OpenAI configuration panel selection.
- [ ] 5.3 Run project test suite and perform manual sanity check of settings open/save/apply flow.
