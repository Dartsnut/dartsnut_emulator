# api.dartsnut.com Dartsnut LLM Bridge Requirements

## Objective

`api.dartsnut.com` is the only bridge between Dartsnut Agent and upstream LLM service.
Desktop sends OpenAI Responses bodies plus community authentication and run ID. API keeps both
Responses and Chat Completions endpoints for existing consumers.
API validates account eligibility, injects upstream credentials/model, proxies response, records usage, and enforces quota.

Hard rules:

- Stable account identity comes from validated community `token`; never trust client account/email.
- Account must have at least one bound Dartsnut machine when starting a run.
- Daily limit is `10,000,000` total input-plus-output tokens per account, reset at `00:00 UTC`.
- The accepted completion that crosses the limit may finish; the run is then closed immediately and cannot issue another completion.
- One active run per account.
- Validation/accounting outages fail closed.
- Usage data stays in api.dartsnut.com's existing MySQL database. Desktop receives no database or upstream LLM credentials.

## API Contract

### Start run

```http
POST /agent/llm/runs/start
token: <community-session-token>
Content-Type: application/json
```

```json
{ "run_id": "uuid" }
```

Processing:

1. Validate token and resolve stable internal account ID.
2. Query current bound machines; reject empty list.
3. Use UTC date for quota row.
4. Atomically reject when `total_tokens >= 10000000`.
5. If another active run has no pending completion, atomically mark it expired with `RUN_SUPERSEDED`; pending completion/accounting work still fails closed.
6. Create run with 30-minute absolute lifetime, 5-minute inactivity lease, and maximum 128 completion requests.

Success:

```json
{
  "code": 1001,
  "data": {
    "run_id": "uuid",
    "usage_date": "2026-07-14",
    "used_tokens": 123456,
    "limit_tokens": 10000000,
    "remaining_tokens": 9876544,
    "expires_at": "2026-07-14T12:30:00Z"
  }
}
```

### Proxy Chat Completions

```http
POST /agent/llm/v1/chat/completions
token: <community-session-token>
x-dartsnut-agent-run-id: <uuid>
Content-Type: application/json
```

Request body remains OpenAI Chat Completions-compatible. API must:

- Revalidate token/account and run ownership.
- Reject forged, expired, finished, or over-request-limit runs.
- Allow the already-accepted completion to finish, then atomically close the run when daily usage reaches 10M.
- Reject every later completion for that quota-closed run with `DAILY_QUOTA_EXCEEDED`.
- Ignore/override client model with server-configured upstream model.
- Inject upstream URL and API key server-side.
- Preserve messages, tools, tool choice, stream mode, reasoning/tool-call deltas, and supported generation fields.
- Force upstream token usage metadata for streaming requests.
- Preserve OpenAI-compatible JSON/SSE responses.
- Capture and atomically persist upstream usage for every accepted completion.
- Refresh inactivity lease without extending 30-minute absolute deadline.
- Count accepted upstream usage even if desktop disconnects before receiving full response.
- Never expose upstream credentials, provider configuration, or raw database errors.

### Proxy Responses

```http
POST /agent/llm/v1/responses
token: <community-session-token>
x-dartsnut-agent-run-id: <uuid>
Content-Type: application/json
```

Request body remains OpenAI Responses-compatible. API applies same ownership, machine, quota,
request-limit, timeout, disconnect, model override, and accounting rules as Chat Completions.
Responses adapter preserves `input`, function calls, reasoning, text, and SSE event records. It
reads response ID and usage from `response.completed`, `response.failed`, or
`response.incomplete`, treats `response.error` as upstream failure, and withholds terminal records
until accounting finishes. Desktop uses this endpoint exclusively.

Both model endpoints stay behind global `jwtAuth` and `apiTokenVerifyRouter`. Only
`PARAMS_MOBILE` and `PARAMS_DARTS_MOBILE` tokens may access `/agent/llm/*`; account identity comes
only from `req.user_info.id`. Neither endpoint belongs in login or permission whitelists, and no
platform permission record is added.

### Finish run

```http
POST /agent/llm/runs/finish
token: <community-session-token>
Content-Type: application/json
```

```json
{ "run_id": "uuid" }
```

Validate ownership, mark run finished, release active-run lock, preserve usage, and make operation idempotent.

## Error Contract

Run endpoints use Dartsnut envelope:

```json
{
  "code": 1040,
  "desc": "Daily Dartsnut LLM quota reached",
  "error": "DAILY_QUOTA_EXCEEDED"
}
```

Both model endpoints return equivalent OpenAI-compatible errors with stable `error.code`.

| HTTP | Error code | Meaning |
|---|---|---|
| 401 | `AUTH_REQUIRED` | Missing, invalid, or expired community session |
| 403 | `NO_BOUND_MACHINE` | Account has no bound machine |
| 409 | `RUN_EXPIRED` | Run finished, expired, or account/run mismatch |
| 429 | `DAILY_QUOTA_EXCEEDED` | Daily total reached before run start or during the preceding completion |
| 429 | `RUN_REQUEST_LIMIT_REACHED` | Granted run exceeded 128 completions |
| 502 | `UPSTREAM_LLM_ERROR` | Upstream rejected or failed |
| 503 | `VALIDATION_UNAVAILABLE` | Account/device validation unavailable |
| 503 | `ACCOUNTING_UNAVAILABLE` | Usage database or accounting unavailable |

## API Database Usage Tracking

Usage data lives in the existing `api.dartsnut.com` MySQL database and uses normal Sequelize models. No external usage database is required.

The API initializes these models through its existing `sequelize.sync({ alter: true })` startup flow:

- `PlatformDartsnutLlmDailyUsage`: one authoritative aggregate per account and UTC date.
- `PlatformDartsnutLlmRun`: agent-run lifecycle, request count, expiry, and run totals.
- `PlatformDartsnutLlmCompletionUsage`: completion-level accounting ledger and idempotency record.
- `PlatformDartsnutLlmAccessEvent`: accepted/rejected run and completion audit.

### Completion ledger

Required data:

- Unique accounting UUID and optional upstream completion ID.
- Stable account ID, run ID, and UTC usage date.
- Actual upstream model and streaming mode.
- Input, output, and total tokens.
- Raw upstream usage JSON for internal reconciliation only.
- Status: `pending`, `completed`, `upstream_failed`, `usage_missing`, or `accounting_failed`.
- Upstream HTTP status and request/completion/accounting timestamps.

Never store prompts, messages, tool arguments, generated content, API keys, or community tokens.

### Run and daily aggregates

Run records contain status, expiry, completion count, token totals, starting daily usage, quota-crossing timestamp, and final stable error code.

Daily records use unique `(account_id, usage_date)` and contain input/output/total tokens, run/completion/rejection counts, first/last usage, quota-crossing timestamp, and accounting health.

Daily aggregate is quota authority. Completion ledger is audit/reconciliation authority.

### Transaction and locking rules

All quota decisions and accounting changes use the existing Sequelize/MySQL transaction manager.

- Lock `PlatformMember` row with `FOR UPDATE` to serialize all LLM accounting for one account, including UTC rollover.
- Lock affected run, completion, and daily rows before mutation.
- Start transaction checks bound machine, expires stale runs, rejects pending accounting, locks/creates daily row, checks quota, and creates run.
- Completion authorization creates one `pending` ledger record before contacting upstream and increments run request count.
- Completion finalization atomically updates ledger, run totals, and daily totals.
- Finish transaction rejects pending/missing accounting, closes run, and increments completed-run count.
- Unique account/date, run ID, and accounting ID indexes prevent duplicate rows.

If successful upstream response lacks usage, mark run `accounting_failed`, mark daily accounting health `reconciliation_required`, and block later runs until repaired. Never count missing usage as zero.

### Retention and reconciliation

Recommended retention:

- Daily and run aggregates: indefinite.
- Completion ledger: 180 days.
- Access events: 90 days.

Hourly reconciliation should recompute run/daily totals from completion ledger and alert on pending records, duplicates, negative values, missing usage, or aggregate mismatches. Retention must not remove current-day or unreconciled records.

## Admin Reporting

Use existing API admin authentication/role middleware. Desktop does not call these endpoints.

### Account summaries

```http
GET /agent/llm/admin/usage/accounts
```

Filters: account ID/search, `date_from`, `date_to`, quota-exceeded state, accounting health, pagination.

Return account ID/display value, input/output/total tokens, run/completion/rejection counts, last usage time, quota-reached days, and accounting health.

### Account detail

```http
GET /agent/llm/admin/usage/accounts/:account_id
```

Return current quota state, daily aggregates, run history, completion ledger metadata, rejection history, and reconciliation warnings for requested date range. Never return prompt/content/token/key data.

### Manual reconciliation

```http
POST /agent/llm/admin/usage/reconcile
```

Admin-only. Support account/day, run, or date-range scope plus dry-run mode. Audit admin identity and result.

## Acceptance Tests

- Token authentication: valid, missing, invalid, expired.
- Binding: zero, one, multiple machines; validation outage.
- Quota: below/equal/above 10M; UTC rollover.
- Concurrency: only one active run; no duplicate completion increments.
- Crossing: accepted completion is accounted, current run is closed, another completion on it is rejected, and the next run is rejected.
- Run limits: inactivity, absolute expiry, 128 requests, idempotent finish.
- Proxy: both protocols, streaming/non-streaming, reasoning deltas, function/tool calls, split SSE records, terminal usage, upstream errors, client disconnect.
- Accounting: normalized counts, atomic ledger/run/daily updates, missing usage fail-closed, reconciliation repair.
- Security: no upstream key or internal details in responses/logs; no prompt/generated-content retention.
- Admin: authorization, filtering, pagination, redaction, reconciliation audit.
