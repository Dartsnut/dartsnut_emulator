# @dartsnut/agent-runtime

Agent session engine, provider client, skills, and workspace tools for Dartsnut desktop.

## Tests

```bash
pnpm run test          # unit tests only (excludes *.e2e.test.ts)
pnpm run test:e2e      # live API end-to-end tests
```

### Provider parity E2E (`breathingWidgetProvider.e2e.test.ts`)

Live tests run **creation intake → widget creator** using LLM credentials from app settings or repo root [`.env`](../../.env.example) (`GPT_*` / `OPENAI_*` bootstrap).

Tests are skipped when credentials are missing. Set `E2E_VERBOSE=1` to log intake/creator phases. Override timeout with `E2E_PROVIDER_TIMEOUT_MS=1800000`.

**Scenario:** initial message `我想要一个可爱的呼吸小组件`, simulated **128x128** chip when the model asks for widget size. Asserts host tool order, transaction tool sequences (vs Xiaomi baseline), agent events (`stream`, `status`, `final`, reasoning when baseline requires it), plus valid `conf.json` and `py_compile`-clean `main.py`.

**Regenerate Xiaomi baseline** (after prompt or model changes):

```bash
export DARTSNUT_REPO_ROOT=/path/to/dartsnut_emulator
UPDATE_E2E_BASELINE=1 pnpm run test:e2e -- breathingWidgetProvider.e2e -t "records baseline"
```

From the monorepo root:

```bash
pnpm run test:e2e:providers
```
