## 1. Layout Restyle

- [ ] 1.1 Update renderer shell structure to enforce a left-side content rail and right-side empty space.
- [ ] 1.2 Adjust setup/timeline/composer section wrappers to fit the new left-anchored layout.
- [ ] 1.3 Add responsive guardrails so left rail remains usable on smaller desktop widths.

## 2. Chat Message Presentation

- [ ] 2.1 Implement role-based message card styling tokens for user, agent, status, and error entries.
- [ ] 2.2 Ensure chat typography and spacing match a Cursor-like transcript hierarchy.
- [ ] 2.3 Keep typed-out agent text behavior compatible with the new card layout.

## 3. Structured Agent Payload Formatting

- [ ] 3.1 Parse mixed narrative + JSON agent payloads into structured view data.
- [ ] 3.2 Render `response` and per-action sections with readable metadata and formatted content blocks.
- [ ] 3.3 Add robust fallback to plain text rendering when payload parsing fails.

## 4. Verification

- [ ] 4.1 Run `npm --prefix apps/desktop run build` to verify renderer and Electron compilation.
- [ ] 4.2 Manually validate transcript rendering for plain responses, action-heavy responses, status, and errors.
