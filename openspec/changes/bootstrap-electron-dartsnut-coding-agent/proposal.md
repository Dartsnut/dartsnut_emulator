## Why

Building Dartsnut applications currently requires manually wiring AI coding tools, runtime setup, and domain knowledge about `pydartsnut`, which creates high onboarding friction for makers who just want to prototype machine-driven pygame apps. We need a packaged desktop experience that lets users quickly point to their own OpenAI-compatible endpoint and immediately validate an in-app coding agent workflow.

## What Changes

- Build an Electron desktop application that embeds a coding agent runtime and supports user-provided OpenAI-compatible API base URL and API key.
- Provide a chat-first interface that displays user prompts and agent progress/actions in a Cursor-like interaction model.
- Add startup flow to select a workspace folder that becomes the agent working root for file operations and code generation.
- Bundle Dartsnut-focused skills/prompts so the agent is optimized for creating and modifying pygame applications that use `pydartsnut`.
- Support an initial proof path where users can complete an end-to-end chat interaction that demonstrates the bundled agent is operational.
- Keep compatibility for an interactive CLI-style agent path in addition to the chat UI.

## Capabilities

### New Capabilities
- `embedded-agent-runtime`: Embedded coding agent execution with user-configured OpenAI-compatible endpoint and credentials.
- `agent-chat-ui`: Desktop chat interface that renders user conversation and live agent activity.
- `workspace-root-selection`: Startup workspace picker that sets the agent's root working directory.
- `dartsnut-skill-bundle`: Packaged domain skills/instructions for generating and editing Dartsnut (`pygame` + `pydartsnut`) apps.
- `first-run-agent-proof`: Guided happy-path interaction proving the bundled agent can execute a real chat task after setup.

### Modified Capabilities
None.

## Impact

- New Electron app shell, renderer UI, and main-process orchestration for agent sessions.
- Integration layer for OpenAI-compatible API settings handling and secure local credential persistence strategy.
- Agent tool/runtime packaging strategy (including optional CLI interaction path) and skill loading.
- Filesystem access boundaries tied to user-selected workspace root.
- QA scope for first-run user journey and observable agent status/progress in UI.
