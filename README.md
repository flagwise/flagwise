# Flagwise

Open-source (Apache-2.0) report triage backend for apps with user-generated content. An in-app user report goes in; an LLM classifies the case once, deterministic rules triage it, a human decides it, and a signed webhook asks your backend to carry out the sanction. Notices, appeals, audit log, erasure and DSA export are built in.

Status: early development, not usable yet. The core rules are implemented and tested: case lifecycle, triage, scoring, webhooks and retries, privacy (identifier hashing, erasure, retention, evidence packages), PII redaction, apps and auth (API keys), audit chain, notifications, analytics and disputes (appeals), plus an in-memory event bus that runs the report-to-action flow end to end. Not built yet: Postgres persistence, the HTTP API (only `/healthz` and `/readyz` exist), LLM adapters, workers and the dashboard.

## Layout

```text
apps/server/            createApp(); MODE=api|worker|all
packages/
  kernel/               Caller, permissions, IDs, clock, errors
  contracts/            internal Zod schemas for events, API, evidence blobs
  plugin-api/           the seam cloud/Pro plugins implement
  platform/             drivers: event bus, timers, storage, rate limit; db + unit of work; defineService
  modules/              one package, Postgres schema and src/service.ts per service:
    apps auth policy flagging classify triage moderation scoring
    delivery disputes privacy notifications audit analytics
spec/                   MIT: openapi.json + webhook JSON Schemas, generated per release
tests/integration/      integration tests of the whole server, driven from outside
scripts/                architecture-lint.ts: the architecture rules only the code's text shows
.env.example            server configuration
```

Inside each module: `src/domain/` (pure logic), `src/app/` (use cases), `src/infra/` (repositories, schema, migrations), `src/api/` (HTTP routes), `src/service.ts` (its composition root: how it boots), `src/index.ts` (the public facade, for the server and tests).

**Boundary rules**, checked by `pnpm lint:deps`: no service imports another (only `contracts`, `kernel` and `platform`); `kernel`, `contracts`, `plugin-api` and `platform` never import services or apps; `tests/` imports no service; every import resolves; no cycles.

**Architecture rules**: beside the boundary rules, `pnpm lint:architecture` checks what only the code's text shows (no service's SQL names another's schema, the server only boots the services, no org), and `apps/server/test/boot.pg.test.ts` boots every service alone on its own tables. Both find the services themselves, so a new service is held to them from its first commit.

**Test suites** (`vitest.config.ts`), all run by `pnpm test` and `pnpm verify`:

| Suite | Files | Tests | Command |
|---|---|---|---|
| unit | each package's `test/*.test.ts` | its code alone; needs nothing | `pnpm test:unit` |
| database | each package's `test/*.pg.test.ts` | its code on a real PostgreSQL: SQL, row-level security, roles, the bus | `pnpm test:database` |
| integration | `tests/integration/` | the whole server, every service wired: installed fresh and driven through the public API, webhooks to a receiver, a fake LLM and the setup commands | `pnpm test:integration` |

Each package keeps its own tests in `test/`; `tests/` holds only the suites that run the whole server.

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
| `pnpm flagwise <command>` | `bootstrap`: an app and its API keys (flagging and actions). `keys:create --app --scope admin`: a key for the case endpoints. `keys:revoke --app --id`: revoke a key at once. `apps:delete`, `apps:restore`: delete an app (its keys answer 410) and restore it within 30 days. `webhooks:add`, `webhooks:list`, `webhooks:remove`, `webhooks:roll-secret`: an app's webhook endpoints and signing secret (needs `SECRETS_ENCRYPTION_KEY`). `secrets:new-key`, `secrets:rewrap`: the master key for secrets at rest and its rotation. `db:init`, `db:migrate`: the database roles and migrations, for the strict setup with separate role URLs (see `.env.example`); with `DATABASE_URL` alone the server does both as it starts |
| `pnpm test` | Every test suite (Vitest), on a throwaway PostgreSQL unless `TEST_DATABASE_URL` is set; `pnpm test:unit`, `test:database`, `test:integration` for one; extra words filter by path (`pnpm test moderation`) |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm lint:deps` | Module boundary check (dependency-cruiser) |
| `pnpm lint:architecture` | The architecture rules only the code's text shows |
| `pnpm verify` | typecheck + lint:deps + lint:architecture + test; run it before opening a pull request |

`pnpm test` (and so `pnpm verify`) needs no settings: it starts a throwaway PostgreSQL from the `embedded-postgres` binaries and removes it afterwards. Set `TEST_DATABASE_URL` to a user that can create databases and roles to use your own instead. Each test file creates its own database and roles with random names and drops them afterwards. Running vitest directly (`pnpm exec vitest`) without the variable skips the tests that need PostgreSQL. `pnpm test:unit` starts none. By default tests reach no other infrastructure: evidence goes to local files, the S3 driver is tested against a fake client, the LLM is a fake provider and webhooks go to a local receiver. To run them end to end on a real S3-compatible store, set `TEST_S3_URL=http(s)://<access key>:<secret>@<host>/<bucket>` with an existing bucket: the API edge test, the server tests and the integration tests then store evidence there through the server. They only read, write and delete in it and leave what the server wrote, so a test bucket with an expiry rule keeps it clean.

`pnpm dev` and `pnpm start` load `.env` when it exists; variables already set in the environment win over it. See `.env.example` for every setting.

The dev server watches folders (`--watch-path`) rather than using plain `--watch`, because plain watch loses a file once git replaces it (checkout, rebase) and keeps serving stale code.

## License

Core: [Apache-2.0](LICENSE). `spec/` and the SDKs: MIT. Contributions are accepted under the same license (Apache-2.0, Section 5); there is no CLA.
