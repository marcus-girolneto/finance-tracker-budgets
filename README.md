# Finance Tracker — take-home task

A personal finance tracker built with TanStack Start, Drizzle (Postgres via
embedded PGlite), TanStack Query, Tailwind/shadcn UI and Paraglide i18n.

**Your task is in [TASK.md](TASK.md).**

## Getting started

Requirements: Node.js 22+ and pnpm 10 (`corepack enable` will pick up the
pinned version). Use `pnpm`, not `npm`.

```bash
pnpm install
pnpm exec playwright install chromium   # for E2E tests
pnpm run dev                            # http://127.0.0.1:3000
```

No `.env` is needed for local development: the database is an embedded
PGlite instance under `./data/pg`. See `.env.example` for optional settings
(set `AI_FAKE=1` if you don't want to configure an AI provider).

`pnpm run check` runs typecheck, lint, unit tests and E2E tests together.
Project conventions are documented in [CLAUDE.md](CLAUDE.md) (identical to
[AGENTS.md](AGENTS.md)).

## Running with Docker

Requirements: Docker 24+ with Compose v2.

```bash
docker compose up --build -d            # app + Postgres -> http://localhost:3000
docker compose logs -f app              # transactional emails (e.g. budget alerts) appear here
docker compose down                     # stop; add -v to also drop the database volume
```

- `APP_PORT=3100 docker compose up --build -d` serves on another host port if 3000 is taken.
- Runs the production image against a real Postgres (`db` service). Migrations apply on
  startup. It is a local-demo configuration: emails are printed to the container log and AI
  calls are faked (`AI_FAKE=1`). Set `SESSION_SECRET` and `POSTGRES_PASSWORD` for anything
  beyond local use.
- Create the first user on `/setup`. Verification links are printed in the app log.

Run the full verification suite (typecheck, lint, unit/integration and Playwright E2E
against the production build) in a container, with no local Node or browser setup:

```bash
docker compose --profile test run --rm --build test
```

Coverage for the core server modules: `pnpm run test:coverage`.

## How we'd like you to work

You're welcome — encouraged — to use AI coding agents. Treat the task as
you would a real feature in an unfamiliar codebase.

In the interview we'll ask you to:

- walk us through your workflow and your conversations with the agent(s);
- explain the design of your solution and how it fits the existing code;
- demo the feature running locally.

Please keep your agent session history and any agent configuration you
used so you can show them. Note that `.gitignore` excludes `.claude/`,
`.agents/`, `.mcp.json` etc. — remove those entries if you'd like to commit
your setup.

## Monthly category budgets

Implements [TASK.md](TASK.md). Screenshots: [docs/screenshots](docs/screenshots).

- **Page:** `/budgets` (sidebar → Budgets). Add a budget for a category with a monthly
  limit, change the limit, remove it. Each budget shows the limit, spent this month,
  what's left, and a red "Over budget" state with the amount over.
- **What counts:** only expenses (negative amounts). Income and refunds never reduce the
  spent amount. A budget on a parent category includes every descendant subcategory.
  "This month" is the current UTC calendar month by transaction date, so budgets reset on
  the 1st without any job. Spending exactly at the limit is not over budget.
- **Alerts:** going over a budget sends one email to the user's verified address. The
  `budget_alerts` ledger (primary key `user_id, category_id, month`) is claimed with
  `INSERT … ON CONFLICT DO NOTHING`. That keeps it at most one email per budget per month,
  even with concurrent requests or if the budget is deleted and recreated. A failed send
  releases the claim so the next spending change retries. Alerts are re-evaluated after
  every write that can change spending.
- **Plans:** Free allows 3 budgets (`BILLING_FREE_MAX_BUDGETS`), Pro is unlimited, via the
  existing `getEntitlements`. Creation locks the user row inside a transaction, so parallel
  requests cannot exceed the limit. After a downgrade existing budgets are kept and only
  new ones are blocked, the same policy as accounts.
- **Compliance:** budgets and alert history are in the GDPR export (`export.json`,
  `budgets.csv`). They are removed on account deletion and with their category. Every
  query is scoped by `user_id` in the same statement.

### Tests

- `pnpm run test`: `tests/budgets.test.ts` runs the real SQL against in-memory Postgres
  (PGlite). It covers rollup, income, month boundaries, tenant isolation, plan limits
  including concurrent creates, alert dedupe under concurrency and delete/recreate, and
  retry after a failed send. `tests/compliance.test.ts` covers export and hard delete.
- `pnpm run test:e2e`: `tests/e2e/budgets.spec.ts` covers navigation, CRUD, validation,
  subcategory rollup, income and previous month excluded, over-budget state, exactly one
  email, category deletion, and Free vs Pro limits.

## Fixes to existing code

- **Category deletion (`deleteCategory`):** it never verified that the category belonged
  to the caller, so any signed-in user could delete another user's unreferenced category.
  It also ran without a transaction, so a mid-way failure left data half-changed. It now
  lives in `src/server/categories.server.ts`, is ownership-checked, and runs in a single
  transaction. Covered by `tests/categories.test.ts`.
- **Receipts:** receipts saved as new transactions were stored as income (positive amount).
  They are now stored as expenses. Existing rows are not migrated.
