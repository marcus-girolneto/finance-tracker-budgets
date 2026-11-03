# Architecture notes: separating frontend and backend

These are observations made while implementing monthly category budgets
([TASK.md](../TASK.md)), together with the target architecture I would move
the codebase to. They were deliberately **not** applied during the assessment.
The task asked not to break existing functionality, and a feature PR that also
re-architects the app would be impossible to review safely.

## Current state and problems

Today the app is a single TanStack Start project. React routes, server functions,
business rules and SQL live in the same `src/` tree and the same deployable.

1. **No boundary between frontend and backend.** UI code and server code share one
   source tree and build. The only guard is a convention (routes import
   `*.functions.ts` only), and breaking it silently leaks server code into the
   client bundle.
2. **Mixed responsibilities (Single Responsibility).** Route components exceed
   1,000 lines (`transactions.tsx` about 1,400, `import.tsx` about 1,400) and mix
   UI, state, data shaping and formatting. Server-function modules
   (`imports.functions.ts` about 1,200, `receipts.functions.ts` about 950) combine
   transport, auth, validation, business rules and SQL in single handlers.
3. **Business logic coupled to the database (Dependency Inversion).** Handlers
   import the Drizzle `db` singleton directly. Use cases cannot be tested without
   a real database, and persistence cannot change independently.
4. **No explicit API contract.** Server functions are RPC calls tied to the
   framework. There is no versioned, documented API that other clients (mobile,
   integrations, MCP) could use.
5. **Duplication and inconsistent errors (DRY).** Ownership checks, tree traversal
   and error handling are repeated. Errors are sometimes free-text strings and
   sometimes codes.
6. **Unsystematic transactions and side effects.** Multi-table writes sometimes
   run without a transaction (`deleteCategory` had an atomicity bug and a missing
   ownership check, fixed in the fixes PR). Emails are sent inline from handlers.

## Target architecture

A pnpm monorepo with two independently deployable apps and shared, framework-free packages:

```
apps/
  web/                      Frontend: React + TanStack Router/Query (SPA or SSR)
    src/features/budgets/   components, hooks (useBudgets), pages
    src/api/                generated, typed API client; no server or DB code
  api/                      Backend: Node + Fastify (REST, OpenAPI)
    src/modules/budgets/
      http/                 controller/routes: auth, validation, DTO mapping only
      application/          use cases (createBudget, getBudgetStatuses, notifyOverBudgets)
      domain/               entities, value objects (Money, Month), pure rules
      infrastructure/       Drizzle repositories, email adapter, outbox worker
    src/shared/             auth, error model, unit of work, DI container, config
packages/
  contracts/                Zod schemas + OpenAPI: the single source of truth for the API
  ui/                       shared design-system components (shadcn)
```

### Backend (`apps/api`): Clean / Hexagonal Architecture

- **Layers with inward dependencies only.** `http → application → domain`.
  `infrastructure` implements ports defined by `application`/`domain`.
  The domain has no framework or SQL imports.
- **Patterns:**
  - **Repository + Unit of Work:** tenant (`user_id`) scoping is enforced in one
    place, and transactions are owned by the use case, so multi-table writes are
    atomic by default.
  - **Dependency Injection:** composition root wiring ports to adapters, which
    makes use cases unit-testable with in-memory fakes.
  - **Domain events + transactional outbox:** emails and notifications run in a
    worker with retries and idempotency, replacing fire-and-forget calls.
  - **Typed `Result`/error codes:** mapped centrally to HTTP status codes and
    problem+json responses. The frontend localizes them by code.
- **REST API, versioned (`/api/v1`) and documented with OpenAPI** generated from
  the shared Zod contracts.
- **Security:** httpOnly session cookie (same-site, served behind one reverse
  proxy) or short-lived tokens, CSRF protection, rate limiting at the edge,
  input validation at the boundary.

### Frontend (`apps/web`)

- Consumes only the typed client generated from `packages/contracts`. It has no
  access to server modules or the database, so bundle leakage is impossible by
  construction.
- Feature-based folders: thin pages, presentational components, and custom hooks
  that wrap TanStack Query (`useBudgets`, `useCreateBudget`).
- Large pages (transactions, import) are split into feature components and hooks.

### Shared contracts (`packages/contracts`)

- Zod schemas for every request/response DTO, imported by both apps. The API
  validates with them, the web client is typed from them, and OpenAPI is
  generated from them. A contract change fails the build on both sides.

### Example: a use case behind ports (backend)

```ts
export interface BudgetRepository {
  countByUser(userId: string): Promise<number>;
  insert(budget: NewBudget): Promise<Budget | null>;
}

export interface UnitOfWork {
  run<T>(work: (repos: { budgets: BudgetRepository; users: UserLock }) => Promise<T>): Promise<T>;
}

export type Result<T, E extends string> = { ok: true; value: T } | { ok: false; error: E };

export class CreateBudget {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly entitlements: EntitlementsPort,
  ) {}

  async execute(userId: string, input: CreateBudgetInput): Promise<Result<Budget, BudgetError>> {
    const { maxBudgets } = await this.entitlements.forUser(userId);
    return this.uow.run(async ({ budgets, users }) => {
      await users.lock(userId);
      if (maxBudgets !== null && (await budgets.countByUser(userId)) >= maxBudgets) {
        return { ok: false, error: "budget_limit_reached" };
      }
      const created = await budgets.insert({ userId, ...input });
      return created ? { ok: true, value: created } : { ok: false, error: "budget_exists" };
    });
  }
}
```

The HTTP controller only authenticates, validates the body against the
`contracts` schema, calls `execute`, and maps the `Result` to a response.

## Migration plan (strangler pattern, no big-bang rewrite)

1. **Monorepo scaffolding.** Move the current app to `apps/web` unchanged, create
   `apps/api` and `packages/contracts`, and keep CI green at every step.
2. **First module: budgets.** Implement it in `apps/api` with the layers above,
   and switch the web budgets page to the typed client. Its existing unit,
   integration and E2E tests act as the safety net.
3. **One module per PR.** Categories, transactions, imports, receipts, billing.
   Add characterization tests before moving each, then delete the corresponding
   server functions from `apps/web`.
4. **Cross-cutting pieces.** The outbox worker for emails, a central error model,
   rate limiting and the auth middleware in the API.
5. **Finish.** Once no server functions remain, `apps/web` is a pure frontend and
   both apps deploy independently (separate Docker images in the existing Compose
   stack: `web`, `api`, `worker`, `db`).

Trade-off: this adds an HTTP hop and a contracts package to maintain. In
exchange it gives enforced boundaries, independent deploys and scaling, a public
API for other clients, and business logic that is testable in isolation.
