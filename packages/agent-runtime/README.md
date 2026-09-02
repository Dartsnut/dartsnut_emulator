# @dartsnut/agent-runtime

Legacy TypeScript agent/session compatibility package. Tauri desktop production
runtime lives in `apps/desktop/src-tauri` and does not bundle this package's
OpenAI/Electron bridge. Package remains for plugin export tooling and migration
tests; new desktop behavior must be implemented in Rust.

## Tests

```bash
pnpm run test          # unit tests
```
