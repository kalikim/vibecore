# Vibecore Delivery Roadmap

Dates are intentionally omitted until team size and release cadence are known.
Progress is controlled by acceptance gates, not feature count.

## Release validation checkpoint (2026-11-23)

Repository CI, executable CLI smoke tests, and offline isolated-production-install
verification are implemented locally. The config package now carries its schema.
Reconciliation approvals are bound to selected ledger state, including health
targets, and unrelated releases are not rechecked. See
[`RELEASE_READINESS.md`](RELEASE_READINESS.md) for reproducible commands and the
remaining release gates. This checkpoint does not mark the milestones below
complete or establish successful live-provider acceptance.

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
- `vibe adopt` (read-only proposal by default) and `vibe doctor`;
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
capabilities, including Supabase and Neon adapter definitions. Exact-approved Prisma,
Drizzle, and declarative MongoDB migration execution is implemented, with production
destructive changes requiring a verified backup checksum. Engine backup and restore
cover PostgreSQL, MySQL/MariaDB, SQLite, and MongoDB without putting credentials in
command arguments. Authenticated hosted-provider project create remains pending. Neon project inspect
and exact-approved branch create on an existing project are implemented; connection
URIs are never returned.
Read-only environment and compatibility diagnostics cover Supabase, Neon, MongoDB
Atlas, PlanetScale, Upstash, and Railway. Local Compose model generation covers
PostgreSQL, MySQL, MariaDB, MongoDB, and Redis with loopback-only ports, credential
references, persistence, and health checks.
Offline tooling inspection covers Prisma SQL, Drizzle SQL, TypeORM and MikroORM
SQL fragments, and declarative MongoDB/Mongoose JSON operations. Exact-approved
TypeORM `migration:run` and MikroORM `migration:up` wrappers are implemented;
`schema:sync`, `migration:revert`, and `migration:down` are refused. Mongoose
execution still uses the declarative MongoDB JSON adapter.

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
is implemented through the versioned API. Production environments set
`prevent_self_review` and can require named GitHub reviewers resolved at apply time.
Vercel Git-connected preview configuration and exact-approved CLI deploy to an
existing project are implemented. Tokens stay in `VERCEL_TOKEN`; org and project
IDs are execution identifiers. Instant rollback is production-only. Automatic
project creation remains pending. Local linking of an existing project writes
`.vercel/project.json` after API verification.
The provider-neutral deployment registry now describes Railway, AWS, Azure,
DigitalOcean, and shared-hosting modes, affordability profiles, credential-name
contracts, workload compatibility, and per-capability status. These entries are
configuration contracts. Native configuration generation is implemented for every
listed mode; remote deployment, health verification, and rollback executors remain
part of the production milestone.
Read-only remote audits detect missing environments, secret-name drift, deployment
branch policy drift, and absent production reviewer rules.
Environment secret synchronization is name-only during planning and streams values
through stdin during exact-approved execution; production requires separate approval.

Deliverables:

- Git setup adapter;
- GitHub repository and Actions plan generation;
- environment-variable contract validation;
- Vercel preview adapter;
- provider registry and workload compatibility for managed cloud, infrastructure,
  and low-cost shared-hosting targets;
- immutable plan artifacts and approval workflow.

Exit gate:

- one planned workflow creates a pull-request preview;
- no secret value appears in workflow files, plans, state, or logs;
- stale plans are rejected.

## Milestone 4 — Production and recovery

Status: Started. The durable local release ledger, bounded HTTP health verification,
and exact-digest rollback planning are implemented. Health records exclude response
bodies and secrets, and rollback can only select a preceding healthy immutable
release for the same application, provider, mode, and environment. Provider-specific
remote execution is implemented for self-hosted Docker over strict SSH, including
versioned Compose releases, digest-pinned images, external health gating, and
exact-approved rollback. Railway forward deployment is implemented with explicit
project/service/environment targeting, project-scoped token isolation, source-state
validation, and external health recording. Railway historical rollback remains
unsupported by its CLI and is not misrepresented as `redeploy`. Other managed-provider
executors and backup hooks remain pending. Interrupted plan and deploying-release
reconciliation is implemented as an exact-approved ledger repair.
DigitalOcean App Platform forward deployment is implemented for existing GitHub-backed
apps with automatic deployment disabled, local and remote revision verification,
temporary token isolation, provider deployment ID recording, external health gating,
and validated historical rollback through the official API. Existing Droplet
execution is implemented: doctl confirms the droplet is active and matches the
approved host, then a digest-pinned Compose release is applied over strict SSH.
Vibecore does not create, patch, or firewall Droplets. Digest-pinned App Platform
container image execution is implemented for existing image-based apps.
Azure forward deployment is implemented for existing App Service, Container Apps, and
disconnected Static Web Apps using the current `az` identity. App Service zip-deploys
an approved git archive, Container Apps shift traffic onto a digest-pinned revision,
and Static Web Apps deploy a built artifact through the SWA CLI. Client secrets are
refused. App Service and Container Apps historical rollback are implemented; Static
Web Apps historical rollback remains unsupported.
AWS forward deployment and rollback are implemented for existing S3/CloudFront,
App Runner, and ECS Fargate resources using the current AWS CLI identity. Static
releases use a versioned S3 prefix and CloudFront origin-path retargeting. Container
releases require digest-pinned images, disabled App Runner auto-deploy, and private
Fargate networking. Access keys are refused as command arguments. Shared-hosting
static and PHP SSH/SFTP execution is implemented with versioned release directories,
atomic `current` symlinks, and exact-approved rollback. Live-tree overwrites, FTP,
passwords, and root SSH are refused.
Database backup, restore, seed, and exact-approved migrate are implemented for
Prisma, Drizzle, TypeORM, MikroORM, and declarative MongoDB JSON operations.
Production destructive migrations require a verified backup checksum. Mongoose
remains inspect-only and shares the MongoDB JSON apply path.

Deliverables:

- self-hosted Docker deployment adapter;
- exact-approved Railway Git and Dockerfile deployment adapters;
- AWS S3 and CloudFront plus App Runner deployment adapters using GitHub OIDC;
- Azure Static Web Apps, App Service, and Container Apps adapters using workload identity;
- DigitalOcean App Platform and hardened Droplet adapters;
- versioned static and PHP shared-hosting releases over SSH/SFTP;
- release ledger and runtime health verification;
- Prisma schema risk classifier;
- database backup hooks;
- rollback and interrupted-deployment reconciliation.

Exit gate:

- a deliberately unhealthy release is detected;
- rollback restores the previous healthy release;
- destructive migrations are blocked without required evidence and approval.

## Milestone 5 — Expo delivery

Status: Started with read-only EAS profile, channel, and `EXPO_PUBLIC_` contract
inspection, plus exact-approved `eas build --no-wait`, `eas update`, and `eas submit --latest`
wrappers. Vibecore does not run local native builds (`--local` is refused).

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
