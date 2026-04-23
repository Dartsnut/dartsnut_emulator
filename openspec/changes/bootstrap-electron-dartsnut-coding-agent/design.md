## Context

The project goal is to package a desktop-first development experience for building Dartsnut applications without requiring users to assemble their own agent tooling stack. The target workflow starts with a first-run setup (endpoint, key, workspace), then continues through a chat UI where users can instruct an embedded coding agent to create or modify `pygame` + `pydartsnut` applications. The architecture must support both GUI chat usage and an optional interactive CLI path, while keeping agent file operations constrained to a user-chosen workspace root.

## Goals / Non-Goals

**Goals:**
- Deliver an Electron shell that runs an embedded coding agent session end-to-end.
- Provide secure local configuration for OpenAI-compatible endpoint and API key.
- Offer a startup workspace picker and enforce that selected folder as the agent root.
- Expose a chat interface that shows user messages and agent progress/events.
- Bundle Dartsnut-specific skills to steer generation toward working `pydartsnut` app patterns.
- Validate a first-run happy path proving the bundled agent can complete chat-driven work.

**Non-Goals:**
- Building a cloud multi-user backend, remote workspace sync, or team collaboration features.
- General marketplace for third-party skills in the first iteration.
- Full production hardening for every provider edge case in the first proof milestone.

## Decisions

1. **Electron main process owns agent orchestration**
   - Run agent lifecycle and tool execution from main process services, with renderer subscribing to structured events over IPC.
   - Rationale: keeps privileged filesystem/network access out of UI context and centralizes policy checks.
   - Alternative considered: running agent in renderer worker; rejected due to weaker process isolation and higher risk of UI stalls.

2. **Workspace root is mandatory before first agent run**
   - Block chat input until workspace selection is complete.
   - Rationale: ensures all file operations are scoped and avoids implicit working-directory behavior.
   - Alternative considered: defaulting to home directory and letting user change later; rejected for safety and predictability.

3. **Provider configuration uses explicit OpenAI-compatible fields**
   - Store `baseUrl`, `apiKey`, and selected model in local app config with OS-keychain-backed secret storage where available.
   - Rationale: supports self-hosted gateways and vendor-compatible APIs while reducing credential exposure.
   - Alternative considered: environment-variable-only setup; rejected because desktop UX needs in-app onboarding.

4. **Skill bundle loaded as first-class bootstrap context**
   - Ship Dartsnut domain instructions/skills with versioned metadata and inject them into every new session.
   - Rationale: directly improves first-response quality for `pygame` + `pydartsnut` tasks.
   - Alternative considered: user-pasted prompts each session; rejected due to poor consistency and setup friction.

5. **Unified session model supports chat UI and interactive CLI**
   - Maintain one session engine with separate frontends (renderer chat + optional CLI adapter).
   - Rationale: avoids duplicated logic and keeps behavior aligned across interfaces.
   - Alternative considered: separate implementations; rejected due to maintenance overhead and drift risk.

## Risks / Trade-offs

- **Credential leakage risk** -> Mitigate by using keychain/secure storage, redacting logs, and never echoing raw keys in UI events.
- **Agent writes outside intended scope** -> Mitigate with strict path normalization and root-prefix enforcement in all file tools.
- **UI feels unresponsive during long agent actions** -> Mitigate with streamed progress events and cancellable operation states.
- **Bundled skills become stale as project evolves** -> Mitigate with versioned skill pack and compatibility checks at startup.
- **OpenAI-compatible API variance causes runtime failures** -> Mitigate with provider capability checks and clear setup-time validation messages.

## Migration Plan

1. Introduce app skeleton modules for config, session engine, workspace policy, and IPC contracts.
2. Integrate provider setup and secure key persistence with startup prompt flow.
3. Implement chat timeline UI and agent event streaming.
4. Add skill bundle loader and session bootstrap injection.
5. Add CLI adapter against the same session engine APIs.
6. Validate first-run proof scenario and capture baseline test coverage for setup and chat interaction.

Rollback strategy: ship behind a feature flag in development builds; disable the bundled agent entrypoint if critical session stability or security issues appear.

## Open Questions

- Which embedded coding agent runtime will be used first (e.g., OpenCode variant), and what packaging/licensing constraints apply?
- Should API keys always live in OS secure storage, or do we need a fallback encrypted file store for unsupported environments?
- What minimum event schema should be considered stable for both chat UI and CLI output rendering?
