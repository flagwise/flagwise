# Flagwise

Open-source (Apache-2.0) report triage backend for apps with user-generated content. An in-app user report goes in; an LLM classifies the case once, deterministic rules triage it, a human decides it, and a signed webhook asks your backend to carry out the sanction. Notices, appeals, audit log, erasure and DSA export are built in.

Status: early development, not usable yet. The core rules are implemented and tested: case lifecycle, triage, scoring, webhooks and retries, privacy (identifier hashing, erasure, retention, evidence packages), PII redaction, tenancy, audit chain, alerts, metrics and appeals, plus an in-memory event bus that runs the report-to-action flow end to end. Not built yet: Postgres persistence, the HTTP API (only `/healthz` and `/readyz` exist), LLM adapters, workers and the dashboard.

## Layout

```text
apps/server/            createApp(); MODE=api|worker|all
packages/
  kernel/               TenantContext, permissions, IDs, clock, errors, defineModule
  contracts/            internal Zod schemas for events, API, evidence blobs
  plugin-api/           the seam cloud/Pro plugins implement
  platform/             drivers: event bus, storage, rate limit; db + unit of work; outbox
  modules/              one package and one Postgres schema per module:
    tenancy intake classify triage cases scoring
    delivery appeals privacy alerts audit metrics
spec/                   MIT: openapi.json + webhook JSON Schemas, generated per release
.env.example            server configuration
```

Inside each module: `src/domain/` (pure logic), `src/app/` (use cases), `src/infra/` (repositories, schema, migrations), `src/api/` (HTTP routes), `src/index.ts` (the public facade; the only file other modules may import).

**Boundary rules**, checked by `pnpm lint:deps`: modules import each other only through `index.ts`; `kernel`, `contracts`, `plugin-api` and `platform` never import modules or apps; no cycles.

## Development

Needs Node 24, pnpm (through corepack), a PostgreSQL database and an SMTP server. TypeScript runs directly on Node (type stripping); there is no build step.

```sh
corepack enable
pnpm install
cp .env.example .env    # then set DATABASE_URL, ...; or export them instead
pnpm flagwise bootstrap --org "Jane Doe Dating" --app "Jane Doe Dating iOS"   # sets up the database, prints the API keys once
pnpm dev                # server with reload on http://localhost:3000 (try /readyz)
```

| Command | What it does |
| --- | --- |
| `pnpm dev` | Server in `MODE=all`, restarted on every change under `apps/server/src` and `packages/` |
| `pnpm start` | Server without reload |
| `pnpm flagwise <command>` | `bootstrap`: the first org, app and API keys (ingest and actions). `keys:create --org --app --scope admin`: a key for the case endpoints. `webhooks:add`, `webhooks:list`, `webhooks:remove`, `webhooks:roll-secret`: an app's webhook endpoints and signing secret (needs `SECRETS_ENCRYPTION_KEY`). `secrets:new-key`, `secrets:rewrap`: the master key for secrets at rest and its rotation. `db:init`, `db:migrate`: the database roles and migrations, for the strict setup with separate role URLs (see `.env.example`); with `DATABASE_URL` alone the server does both as it starts |
| `pnpm test` | Every package's tests (Vitest) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint:deps` | Module boundary check (dependency-cruiser) |
| `pnpm verify` | typecheck + lint:deps + test; run it before opening a pull request |

Tests that need PostgreSQL run when `TEST_DATABASE_URL` is set to a user that can create databases and roles (for example `postgres://postgres:postgres@localhost:5432/postgres`). Each test file creates its own database and roles with random names and drops them afterwards. Without the variable those tests are skipped.

`pnpm dev` and `pnpm start` load `.env` when it exists; variables already set in the environment win over it. See `.env.example` for every setting.

The dev server watches folders (`--watch-path`) rather than using plain `--watch`, because plain watch loses a file once git replaces it (checkout, rebase) and keeps serving stale code.

## License

Core: [Apache-2.0](LICENSE). `spec/` and the SDKs: MIT. Contributions are accepted under the same license (Apache-2.0, Section 5); there is no CLA.
