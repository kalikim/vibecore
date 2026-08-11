# Vibecore Delivery Roadmap

Dates are intentionally omitted until team size and release cadence are known.
Progress is controlled by acceptance gates, not feature count.

## Milestone 0 — Contracts

Deliverables:

- product specification and architecture decisions;
- `vibecore.yaml` schema and example manifests;
- diagnostic, action, plan, adapter, and release TypeScript contracts;
- threat model and secret-redaction test cases;
- two reference repository fixtures.

Exit gate:

- web/API/mobile reference projects can be represented without core provider fields;
- schema examples validate;
- a design review accepts the action and permission model.

## Milestone 1 — Inspect and diagnose

Status: In progress

Deliverables:

- pnpm monorepo and CLI shell;
- manifest parser with source-aware validation errors;
- read-only repository scanner;
- Next.js, Expo, Hono, Prisma, and pnpm detection;
- Python/FastAPI/Django, Go/Gin, PHP/Laravel, Rust/Axum, Java/Kotlin Spring Boot,
  and .NET/ASP.NET Core detection;
- `vibe adopt --plan` and `vibe doctor`;
- human and JSON output.
- deterministic OpenAPI 3.1 scaffolding and framework-specific Swagger guidance;

Exit gate:

- commands never write during detection;
- fixture repositories produce stable golden diagnostics;
- unsupported stacks receive actionable, honest output.

## Milestone 2 — Local orchestration

Status: Started with project graph, immutable plans, policy evaluation, local state,
the guarded adoption executor, local process supervision, environment contracts,
project-scoped Docker Compose lifecycle management, and read-only Prisma migration
inspection. The database registry now separates engine, tooling, and hosted-provider
capabilities, including Supabase and Neon adapter definitions. Migration execution
and authenticated provider operations remain pending. Read-only environment and
compatibility diagnostics cover Supabase, Neon, MongoDB Atlas, PlanetScale, Upstash,
and Railway. Local Compose model generation covers PostgreSQL, MySQL, MariaDB,
MongoDB, and Redis with loopback-only ports, credential references, persistence,
and health checks.
Offline tooling inspection now covers Prisma SQL, Drizzle SQL, and declarative
MongoDB operations. TypeORM, MikroORM, and framework-native Mongoose discovery remain
pending.

Deliverables:

- action planner, policy checks, executor, and local state;
- `vibe dev` session supervision;
- Docker Compose PostgreSQL and Redis resources;
- migrations, port allocation, health checks, and aggregated logs;
- safe shutdown and interrupted-session reconciliation.

Exit gate:

- the reference stack starts healthy from a clean checkout;
- failures identify the responsible component;
- cleanup never stops unrelated processes or containers.

## Milestone 3 — Repository automation and previews

Status: Started with deterministic GitHub Actions and Dependabot generation,
least-privilege permissions, exact-digest approval, and standardized `dev`, `staging`,
and `production` environment gates. Exact-approved remote GitHub environment creation
is implemented through the versioned API; secret upload, reviewer selection, and
preview deployment adapters remain pending.
Read-only remote audits detect missing environments, secret-name drift, deployment
branch policy drift, and absent production reviewer rules.
Environment secret synchronization is name-only during planning and streams values
through stdin during exact-approved execution; production requires separate approval.

Deliverables:

- Git setup adapter;
- GitHub repository and Actions plan generation;
- environment-variable contract validation;
- Vercel preview adapter;
- immutable plan artifacts and approval workflow.

Exit gate:

- one planned workflow creates a pull-request preview;
- no secret value appears in workflow files, plans, state, or logs;
- stale plans are rejected.

## Milestone 4 — Production and recovery

Deliverables:

- self-hosted Docker deployment adapter;
- release ledger and runtime health verification;
- Prisma schema risk classifier;
- database backup hooks;
- rollback and interrupted-deployment reconciliation.

Exit gate:

- a deliberately unhealthy release is detected;
- rollback restores the previous healthy release;
- destructive migrations are blocked without required evidence and approval.

## Milestone 5 — Expo delivery

Deliverables:

- EAS profile and channel validation;
- environment and API endpoint coordination;
- deep-link and native configuration diagnostics;
- build/update planning and release association.

Exit gate:

- preview and production mobile builds use the correct environment contracts;
- OTA updates are associated with a recorded source revision and release.

## Milestone 6 — Extensibility and hosted control plane

Potential deliverables:

- isolated community plugin host and signing model;
- reusable blueprints and policy packs;
- remote team dashboard, RBAC, and audit history;
- additional deployment and resource adapters;
- agent protocol or MCP interface.

This milestone begins only after adapter contracts have survived multiple internal
implementations without provider-specific changes to the core.
