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
