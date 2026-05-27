# E2E baseline fixtures

`breathing-widget-xiaomi-baseline.json` is the reference tool/event sequence for provider parity tests.

Regenerate when intake or creator prompts change:

```bash
export DARTSNUT_REPO_ROOT=/path/to/dartsnut_emulator
UPDATE_E2E_BASELINE=1 pnpm --dir packages/agent-runtime run test:e2e -- breathingWidgetProvider.e2e -t "records baseline"
```

Until regenerated, placeholder `intakeToolNames` / `creatorToolNames` arrays may be empty and strict sequence checks will fail until a successful Xiaomi run updates the file.
