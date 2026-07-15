# Dartsnut LLM E2E Environment

Baseline E2E stack uses Docker:

- MySQL 8.4: API-owned database on host port `13306`.
- Redis 7: token/session store on host port `16379`.
- Mock OpenAI-compatible LLM: internal port `4000`.
- `api.dartsnut.com` dev process: host port `13300`.

## Run

From `dartsnut_emulator`:

```bash
pnpm run e2e:up
pnpm run test:e2e
pnpm run e2e:down
```

`pnpm run e2e:up` builds and starts sibling `../dartsnut-community-api`, waits for API health, and seeds test accounts/devices/model config.

`pnpm run test:e2e` runs both suites:

1. API E2E:
   - Account without bound machine rejected.
   - Bound account reaches mock LLM.
   - Token usage crosses low E2E quota.
   - Next run rejected.
2. Agent bridge E2E:
   - Desktop bridge starts run.
   - Sends authenticated streaming request.
   - Receives mocked response and usage.
   - Finishes run.

## Test accounts

```text
e2e@example.com / test-password
agent-e2e@example.com / test-password
unbound@example.com / test-password
```

E2E quota is intentionally `10` tokens. Production remains `10,000,000`.

## Useful commands

```bash
cd ../dartsnut-community-api
npm run e2e:up
npm run test:e2e
npm run test:llm

docker compose -f docker-compose.e2e.yml logs -f api
docker compose -f docker-compose.e2e.yml ps
npm run e2e:down
```

E2E MySQL data is disposable. `e2e:down` removes its Docker volume.
