## Context

The application currently uses embedded `.env` values for LLM endpoint, API key, and model selection, and the main view has no built-in runtime settings surface. Users need a fast, keyboard-first way to override these values without editing files, with behavior that works consistently on macOS and Windows/Linux.

## Goals / Non-Goals

**Goals:**
- Add a cross-platform shortcut to open settings (`Cmd+,` on macOS and `Ctrl+,` on Windows/Linux).
- Replace the main view with a settings screen while settings are active.
- Provide a settings menu with an OpenAI configuration item.
- Persist user-entered endpoint, API key, and model values.
- Apply persisted user values as the first source for LLM calls, with `.env` values as fallback.

**Non-Goals:**
- Adding multiple settings categories beyond OpenAI configuration in this change.
- Supporting provider-specific validation beyond required field checks.
- Introducing cloud sync or multi-profile configuration management.

## Decisions

1. **Use existing input event system for shortcut routing**
   - Capture the platform-specific modifier + comma shortcut at app level, then dispatch a route/state transition to settings mode.
   - **Why:** Keeps keyboard behavior centralized and avoids per-screen key bindings.
   - **Alternative considered:** Add a visible settings button only. Rejected because the request explicitly requires shortcut-driven entry.

2. **Model settings as a top-level view state that replaces main view**
   - Implement settings as a first-class screen state instead of overlay modal.
   - **Why:** Matches the requested behavior ("replace main view") and simplifies focus and navigation handling.
   - **Alternative considered:** Modal or side panel. Rejected because it does not fully replace the main view.

3. **Persist OpenAI runtime configuration in local user settings storage**
   - Store `endpoint`, `apiKey`, and `model` under a dedicated settings namespace.
   - **Why:** Persists across restarts and avoids coupling to environment file edits.
   - **Alternative considered:** In-memory only storage. Rejected due to losing config on restart.

4. **Resolve LLM config with precedence: user settings > `.env` defaults**
   - At call time (or client initialization), load user settings first and fill missing values from environment defaults.
   - **Why:** Ensures explicit user configuration reliably overrides defaults while preserving safe fallback.
   - **Alternative considered:** Replace `.env` entirely once any field is set. Rejected because partial user configuration should not break calls.

5. **Require basic validation before save/use**
   - Validate non-empty API key and model; endpoint must be parseable URL when provided.
   - **Why:** Prevents obvious runtime failures and supports partial fallback rules.
   - **Alternative considered:** No validation until request time. Rejected due to poor user feedback loop.

## Risks / Trade-offs

- **Shortcut conflict with existing bindings** -> Mitigate by checking current keymap and gating behavior by focused context.
- **Sensitive API key exposure in logs/UI state** -> Mitigate by masking key in UI display, avoiding debug logging, and using existing secure settings persistence where available.
- **Partial configuration may create ambiguous behavior** -> Mitigate with explicit precedence rules and clear helper text on fallback to `.env`.
- **Cross-platform modifier detection inconsistencies** -> Mitigate with platform-aware key normalization tests for macOS and Windows/Linux.
