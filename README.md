# Vibecore

Website: [vibecore.build](https://vibecore.build)

Vibecore is a local-first application orchestration platform for AI-assisted
developers. It coordinates the repetitive work around an application: project
discovery, local services, Git and GitHub setup, database safety, validation,
deployment, and release recovery, without replacing the frameworks developers
already use.

## Language support

Run `pnpm vibe languages` to inspect the language adapter registry. First-class
detection currently covers JavaScript/TypeScript, Python, Go, PHP, Rust, Java,
Kotlin, and .NET, including FastAPI, Django, Gin, Laravel, Axum, Spring Boot, and
ASP.NET Core. Package-tool detection covers pnpm/npm/yarn/bun, uv/pip/Poetry, Go
modules, Composer, Cargo, Maven/Gradle, and dotnet/NuGet.

Detected applications receive structured direct-execution commands where their
entrypoint is unambiguous. FastAPI projects are detected but do not receive a
guessed module path; Vibecore requires that command to be declared explicitly.

## API documentation

Vibecore generates deterministic OpenAPI 3.1 contracts and maps them to Swagger or
framework-native documentation adapters for Hono, NestJS, Express, FastAPI, Django,
Gin, Laravel, Axum, Spring Boot, and ASP.NET Core.

```sh
pnpm vibe api adapters
pnpm vibe api docs --application api --output apps/api/openapi.yaml
pnpm vibe api docs --application api --output apps/api/openapi.yaml --write
pnpm vibe api docs --application api --output apps/api/openapi.yaml --write --approve <digest>
```

Generation is preview-first, requires exact digest approval, refuses overwrites and
repository path escapes, and uses relative server URLs to avoid leaking internal
hosts. Interactive Swagger UI should remain disabled or authenticated in production;
setting `applications.<name>.config.docs.publicProduction: true` produces a warning.

Route discovery is static and never imports or executes application code. Literal
routes are extracted from Hono, Express, FastAPI, Django, Gin, Laravel, Axum, Spring
Boot, and ASP.NET Core sources. Express-style `:id` and Django converters are emitted
as OpenAPI `{id}` parameters. Ambiguous mappings are marked with
`x-vibecore-review: true` rather than presented as certain.

The project is in active early development. The source of truth is:

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md): product goals and v1 scope
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): system boundaries and contracts
- [`schemas/vibecore.schema.json`](schemas/vibecore.schema.json): initial manifest schema
- [`docs/ROADMAP.md`](docs/ROADMAP.md): delivery phases and acceptance gates
- [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md): threats, safeguards, and limitations
- [`docs/EDITOR_INTEGRATIONS.md`](docs/EDITOR_INTEGRATIONS.md): CLI and planned MCP integrations
- [`docs/adr/`](docs/adr/): architecture decisions

## Intended experience

```sh
vibe adopt
vibe doctor
vibe dev
vibe github setup --plan
vibe deploy --environment preview
```

The first CLI milestone provides read-only repository adoption and diagnostics:

```sh
pnpm install
pnpm vibe adopt
pnpm vibe doctor
pnpm vibe doctor --json
pnpm vibe doctor --environment local
pnpm vibe history
```

`vibe adopt` detects supported package managers, applications, and local resources,
then prints a proposed manifest without changing the repository.

To create a new manifest, request a write plan, review its digest, and approve that
exact plan:

```sh
pnpm vibe adopt --write
pnpm vibe adopt --write --approve <full-plan-digest>
```

Adoption refuses stale approvals, modified plans, paths outside the repository, and
existing manifests.

Successful and failed executions are recorded in a local, redacted
`.vibecore/state.json` ledger. Action inputs and secret values are never retained in
that file.

Applications with a declared `commands.dev` can be started under one supervised
session:

```sh
pnpm vibe dev
```

Commands are executed directly without a shell. Vibecore assigns stable local ports,
waits for configured health checks, prefixes application logs, and stops only the
processes created by the current session.

When an environment uses `docker-compose`, Vibecore starts its Compose project with
a repository-specific project name and waits for resource readiness before starting
applications. Shutdown removes only that Compose project and preserves named volumes.
Required environment variables are validated first, and declared secret values are
redacted from application and Docker output.

Prisma projects can inspect migration history without connecting to or changing a
database:

```sh
pnpm vibe db inspect
pnpm vibe db inspect --json
```

The inspection records SHA-256 checksums and conservatively classifies each SQL
statement as `safe`, `review`, or `destructive`. A destructive result exits with code
2 so it can be enforced in CI. Live checks remain read-only and use the project's
installed Prisma CLI:

```sh
pnpm vibe db check validate
pnpm vibe db check status
pnpm vibe db check drift
```

`status` compares local migration history with Prisma's migration table. `drift`
compares the configured live datasource with the schema and exits with code 2 when
changes are detected. Database credentials are never accepted as command arguments,
and known secret environment values are redacted from captured output.

## Database adapter model

Database support is split into independent layers so an engine is not confused with
an ORM or a hosting company:

<table>
  <thead>
    <tr style="background-color:#1f2937;color:#ffffff">
      <th>Layer</th>
      <th>Registered adapters</th>
      <th>Purpose</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>Engines</td><td>PostgreSQL, MySQL, MariaDB, MongoDB, Redis, SQLite, SQL Server, CockroachDB</td><td>Storage behavior and local runtime</td></tr>
    <tr><td>Tools</td><td>Prisma, Drizzle, TypeORM, MikroORM, Mongoose</td><td>Schema, validation, and migrations</td></tr>
    <tr><td>Providers</td><td>Supabase, Neon, MongoDB Atlas, PlanetScale, Upstash, Railway</td><td>Hosted provisioning and operational APIs</td></tr>
  </tbody>
</table>

Inspect the live capability registry with:

```sh
pnpm vibe db support
pnpm vibe db support --kind provider
pnpm vibe db support --json
```

The registry distinguishes `implemented`, `planned`, and `unsupported` capabilities.
Supabase and Neon are registered PostgreSQL provider adapters. Their detection is
implemented; authenticated provisioning, branching, backup verification, and
deployment operations remain explicitly marked as planned.

Validate a selected stack and its environment contract without connecting to or
modifying the provider:

```sh
pnpm vibe db doctor --engine postgresql --tool prisma --provider supabase
pnpm vibe db doctor --engine postgresql --tool drizzle --provider neon
pnpm vibe db doctor --engine mongodb --tool mongoose --provider mongodb-atlas
pnpm vibe db doctor --engine redis --provider upstash
```

Diagnostics cover every registered hosted provider, check compatible engine/tool/
provider combinations, validate required variable presence and URL shape, and detect
incomplete control-plane credential pairs. Values are used only for validation and
never included in human output, JSON output, plans, or state.

Local PostgreSQL, MySQL, MariaDB, MongoDB, and Redis resources can also be rendered
before startup:

```sh
pnpm vibe db compose
pnpm vibe db compose --json
pnpm vibe dev
```

When the local environment uses `docker-compose` and no Compose file exists,
`vibe dev` writes a generated, gitignored model to
`.vibecore/generated/compose.database.yaml`. Generated services bind only to
`127.0.0.1`, persist data in named volumes, use health checks, enable
`no-new-privileges`, and require passwords through environment-variable references.
The generated file contains no credential values. Shutdown remains scoped to the
current Vibecore Compose project and preserves its volumes.

Example database resources:

```yaml
resources:
  database:
    type: database
    provider: postgres
    config:
      version: 17-alpine
  documents:
    type: database
    provider: mongodb
    config:
      replicaSet: true
  cache:
    type: cache
    provider: redis
```

MongoDB replica-set mode creates its keyfile inside the container from the required
`MONGO_REPLICA_SET_KEY` secret and initiates a single-node `rs0` during readiness.
This supports local transactions without committing a reusable keyfile.

Drizzle and MongoDB migrations can be inspected offline:

```sh
pnpm vibe db inspect-tool --tool drizzle --path drizzle
pnpm vibe db inspect-tool --tool mongodb --path migrations/mongodb
```

Drizzle inspection supports both flat `.sql` files and timestamped directories with
`migration.sql`. MongoDB uses ordered declarative JSON files containing an
`operations` array. Supported operation types are `createCollection`, `createIndex`,
`collMod`, `renameCollection`, `dropIndex`, `updateMany`, `deleteMany`, and
`dropCollection`. Unknown operations are blocked as destructive instead of executing
arbitrary JavaScript.
