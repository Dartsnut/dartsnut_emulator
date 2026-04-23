## 1. Foundation and project scaffolding

- [ ] 1.1 Create Electron app module structure for main process, renderer, shared IPC contracts, and session engine boundaries.
- [ ] 1.2 Add baseline dependencies and build scripts for Electron runtime, secure storage integration, and renderer UI tooling.
- [ ] 1.3 Define typed session/event contracts shared by chat UI and optional CLI adapter.

## 2. Provider setup and secure configuration

- [ ] 2.1 Implement provider settings model for OpenAI-compatible `baseUrl`, `apiKey`, and model selection.
- [ ] 2.2 Implement secure persistence path for API key (keychain-backed with documented fallback behavior).
- [ ] 2.3 Add provider validation flow that blocks session start on invalid configuration and returns actionable errors.

## 3. Workspace root policy

- [ ] 3.1 Implement startup workspace folder selection flow and persist active workspace root.
- [ ] 3.2 Gate chat/session start until workspace selection is completed.
- [ ] 3.3 Enforce workspace root path policy in all agent filesystem operations with explicit rejection events.

## 4. Embedded agent runtime

- [ ] 4.1 Implement main-process agent session orchestration that initializes with configured provider settings.
- [ ] 4.2 Implement streaming of agent lifecycle and tool progress events over IPC to consumers.
- [ ] 4.3 Add cancellation and failure-state handling paths for long-running or failed agent actions.

## 5. Chat UI and interaction flow

- [ ] 5.1 Build chat timeline UI that renders ordered user prompts and final agent responses.
- [ ] 5.2 Build live activity panel/inline state rendering for in-progress agent operations and errors.
- [ ] 5.3 Connect renderer chat actions to session engine APIs and verify state synchronization across turns.

## 6. Dartsnut skill bundle integration

- [ ] 6.1 Package bundled Dartsnut skills/instructions with versioned metadata in application assets.
- [ ] 6.2 Implement skill loading and injection into each new agent session before first prompt processing.
- [ ] 6.3 Add startup/session validation that blocks runs when bundled skill metadata is missing or invalid.

## 7. Optional CLI path and parity checks

- [ ] 7.1 Implement interactive CLI adapter against the same session engine used by the chat UI.
- [ ] 7.2 Ensure provider setup, workspace policy, and skill bundle behavior are consistent between chat and CLI entrypoints.

## 8. First-run proof and verification

- [ ] 8.1 Implement first-run guide state that tracks setup completion and first successful chat interaction.
- [ ] 8.2 Create an end-to-end proof script/test that performs setup, sends an initial prompt, and verifies visible agent response.
- [ ] 8.3 Add regression tests for provider validation errors, workspace boundary enforcement, and skill-bundle load failures.
