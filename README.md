# Vibecore

Website: [vibecore.build](https://vibecore.build)

License: [MIT](LICENSE). This covers the public Vibecore repository, not the
separate private website. Third-party dependencies retain their own licenses.

Release preparation: `0.1.0-alpha.1`. npm publication is not yet verified.
The npm CLI package is `@codexsafari/vibecore`; its executable remains `vibe`.
Maintainers: follow the [alpha publishing checklist](docs/PUBLISHING.md).

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

Use the documentation quality gate locally or in CI:

```sh
pnpm vibe api check --application api --spec apps/api/openapi.yaml
pnpm vibe api check --application api --spec apps/api/openapi.yaml --json
```

It validates OpenAPI structure, unique operation IDs, successful responses, required
path parameters, source-route coverage, stale operations, server URL hygiene, and
security declarations. Unsecured `/admin`, `/internal`, `/debug`, or `/metrics`
operations are errors; missing security on ordinary business operations is a warning.

The project is in active early development. The source of truth is:

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md): product goals and v1 scope
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): system boundaries and contracts
- [`schemas/vibecore.schema.json`](schemas/vibecore.schema.json): initial manifest schema
- [`docs/ROADMAP.md`](docs/ROADMAP.md): delivery phases and acceptance gates
- [`docs/RELEASE_READINESS.md`](docs/RELEASE_READINESS.md): repeatable validation, portable-install checks, and release blockers
- [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md): threats, safeguards, and limitations
- [`docs/EDITOR_INTEGRATIONS.md`](docs/EDITOR_INTEGRATIONS.md): CLI and planned MCP integrations
- [`docs/adr/`](docs/adr/): architecture decisions

## Intended experience

Review a local resource-conscious report before starting remote work:

```sh
pnpm vibe plan --environment staging --budget-conscious
pnpm vibe plan --environment staging --budget-conscious --save --json
```

Plan Mode makes no network or AI calls and executes no operations. It writes only
when `--save` is supplied. Reports are advisory, costs remain unknown, and applying
changes still requires an operation-specific plan. See [Plan Mode](docs/PLAN_MODE.md)
for saved-report checks and limitations.

```sh
vibe init
vibe adopt
vibe doctor
vibe dev
vibe github setup --plan
vibe deploy --environment preview
```

Create a manifest from a blueprint, or adopt an existing repository. Init never
generates application source:

```sh
pnpm vibe init --list
pnpm vibe init --blueprint reference
pnpm vibe init --blueprint reference --write --approve <digest>
```

If the repository already has detectable applications, use `vibe adopt` instead.

The first CLI milestone provides read-only repository adoption and diagnostics:

```sh
pnpm install
pnpm vibe adopt
pnpm vibe doctor
pnpm vibe doctor --json
pnpm vibe doctor --environment dev
pnpm vibe history
pnpm vibe expo inspect
pnpm vibe expo inspect --application mobile --json
pnpm vibe expo build --application mobile --revision <git-sha> --profile preview
pnpm vibe expo update --application mobile --revision <git-sha> --channel preview
pnpm vibe expo submit --application mobile --revision <git-sha> --platform ios
pnpm vibe reconcile
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

Vibecore standardizes deployments around `dev`, `staging`, and `production`.
Development can load gitignored env files, while staging and production use
environment-scoped secret sources. Legacy `local` and `preview` names remain readable
but are no longer generated by adoption.

When an environment uses `docker-compose`, Vibecore starts its Compose project with
a repository-specific project name and waits for resource readiness before starting
applications. Shutdown removes only that Compose project and preserves named volumes.
Required environment variables are validated first, and declared secret values are
redacted from application and Docker output.

Secure GitHub workflow generation is preview-first:

```sh
pnpm vibe github setup
pnpm vibe github setup --json
pnpm vibe github setup --write
pnpm vibe github setup --write --approve <digest>
```

It creates CI, deployment-gate, and Dependabot files with read-only repository
permissions, non-persistent checkout credentials, frozen dependency installation,
concurrency controls, timeouts, and GitHub environment gates for `dev`, `staging`,
and `production`. Secret values are never written; the plan reports only required
secret names. Production deployment remains a validation gate until a deployment
adapter is configured.

Remote GitHub environments use a separate approval boundary:

```sh
pnpm vibe github environments --repository owner/repository
pnpm vibe github environments --repository owner/repository --json
pnpm vibe github environments --repository owner/repository --reviewers alice,bob --apply --approve <digest> --production-approved
```

The executor uses GitHub's versioned environment API through the authenticated `gh`
CLI. It creates `dev`, `staging`, and `production`; staging and production accept only
protected branches. It does not upload secret values. Required secret names remain a
redacted configuration checklist, and production reviewers must be configured in
GitHub because reviewer identities cannot be safely guessed.

Audit remote configuration without reading secret values:

```sh
pnpm vibe github audit --repository owner/repository
pnpm vibe github audit --repository owner/repository --json
```

The audit compares standard environments, required secret names, protected deployment
branches, unexpected legacy secrets, and production reviewer rules. GitHub's secret
API returns names and timestamps only; Vibecore never requests decrypted values.

Configure a Git-connected Vercel preview without putting tokens in Actions commands:

```sh
pnpm vibe deploy setup --provider vercel --application web --revision <git-sha>
pnpm vibe deploy setup --provider vercel --application web --revision <git-sha> --write
pnpm vibe deploy setup --provider vercel --application web --revision <git-sha> --write --approve <digest>
```

The plan creates `vercel.json`, binds configuration review to an immutable source
revision, reports required secret names only, and refuses overwrites. Connect the
repository in Vercel and map `staging` to Preview; Vercel will then create preview
deployments from branches and pull requests without a CLI token in GitHub Actions.

Deploy an approved revision to an existing Vercel project:

```sh
pnpm vibe deploy vercel \
  --application web \
  --environment staging \
  --revision <git-sha> \
  --org <team-or-org-id> \
  --project <project-id> \
  --health-url https://app.example.com/health
```

Review the plan, export `VERCEL_TOKEN`, and repeat with `--apply --approve <digest>`.
Vibecore checks that `HEAD` still matches the approved revision and that the
application path is clean. The token, org ID, and project ID are process
environment values, never CLI flags. Production uses `--prod` and requires
`--production-approved`. Instant rollback is production-only:
`vibe deploy vercel-rollback`. Link an existing project locally with
`vibe deploy vercel-link --application web --org <id> --project <id>` after
exporting `VERCEL_TOKEN`.

Preview an HTTPS Nginx reverse-proxy candidate for an existing certificate:

```bash
vibe deploy nginx --domain app.example.com --port 3000 --json
```

This is read-only configuration generation, not server setup. It validates inputs,
targets a loopback upstream, and includes limitations and an activation checklist.
It does not issue certificates, modify existing sites, or reload Nginx.
See [Nginx candidates and source-only CLI access](docs/NGINX.md).

Run `pnpm test:nginx` with Docker and OpenSSL on Linux to exercise the candidate
against a real isolated Nginx instance, including HTTPS and failed-reload checks.

Discover every deployment target and its honest implementation status:

```sh
pnpm vibe deploy support
pnpm vibe deploy support --provider railway
pnpm vibe deploy support --application web
pnpm vibe deploy support --application web --json
```

<table>
  <thead style="background-color: #111827; color: #f9fafb;">
    <tr><th>Provider</th><th>Deployment modes</th><th>Resource profile</th><th>Current status</th></tr>
  </thead>
  <tbody>
    <tr><td>Vercel</td><td>Git-connected static and Node web apps</td><td>Free tier, usage based</td><td>Preview configuration, CLI deploy, and production rollback implemented</td></tr>
    <tr><td>Railway</td><td>Git source, Railpack, Dockerfile</td><td>Low cost, usage based</td><td>Configuration implemented</td></tr>
    <tr><td>AWS</td><td>S3 and CloudFront, App Runner, ECS Fargate</td><td>Free tier, usage based, infrastructure</td><td>Forward deployment and rollback implemented</td></tr>
    <tr><td>Azure</td><td>Static Web Apps, App Service, Container Apps</td><td>Free tier, usage based, infrastructure</td><td>App Service and Container Apps execution implemented; Static Web Apps artifact deploy implemented</td></tr>
    <tr><td>DigitalOcean</td><td>App Platform, Droplet</td><td>Low cost, usage based, infrastructure</td><td>App Platform and existing Droplet forward deploy and rollback implemented</td></tr>
    <tr><td>Shared hosting</td><td>Static or PHP artifact over SSH/SFTP</td><td>Low cost</td><td>Versioned upload and atomic-symlink rollback implemented</td></tr>
  </tbody>
</table>

Support is capability based, not a provider-name promise. `vibe deploy support`
reports the accepted workloads and whether preview, deploy, and rollback are
implemented, planned, or unsupported for each mode. A manifest can explicitly set
`applications.<name>.config.deploymentWorkload: container` when its Dockerfile is the
deployment boundary. Expo/mobile releases remain on their separate EAS and app-store
path.

Cloud workflows will prefer short-lived GitHub OIDC identities. Shared hosting is a
deliberately narrower compatibility path for developers with existing inexpensive
hosting: versioned static builds and PHP applications upload over SSH/SFTP into
`releases/<sha>/`, then `current` is atomically repointed. Plain FTP, passwords in
command arguments, root SSH deployment, live-tree overwrites, and secret values in
plans are refused.

See [deployment adapters](docs/DEPLOYMENTS.md) for every mode, generated artifact,
account prerequisite, identity boundary, health contract, and rollback strategy.

Inspect recorded releases, verify a newly deployed endpoint, and produce a safe
rollback plan:

```sh
pnpm vibe deploy releases
pnpm vibe deploy verify-health --release <release-id> --url https://example.com/health
pnpm vibe deploy rollback --release <failed-release-id>
```

Release records contain provider, environment, immutable revision, status, and
bounded health evidence. They never contain runtime secrets or response bodies.
Rollback selects only a preceding healthy release for the same application,
provider, mode, and environment. The command creates an exact-digest plan; it does
not claim that a provider rollback occurred before a remote executor applies it.

Self-hosted Docker is the first complete remote executor:

```sh
pnpm vibe deploy self-hosted \
  --application api \
  --environment staging \
  --revision <git-sha> \
  --host app.example.com \
  --user vibecore \
  --health-url https://app.example.com/health
```

The application manifest must set `config.deploymentWorkload: container` and an
immutable `config.deploymentImage` containing `@sha256:<digest>`. Review the plan,
then repeat it with `--apply --approve <digest> --ssh-key /absolute/key/path`.
Production additionally requires `--production-approved`.

Railway remote deployment is also available for existing projects, services, and
environments:

```sh
pnpm vibe deploy railway \
  --application api \
  --environment staging \
  --revision <current-git-sha> \
  --project <railway-project> \
  --service <railway-service> \
  --health-url https://api.example.com/health
```

Review the plan, export a project-scoped `RAILWAY_TOKEN`, and repeat with
`--apply --approve <digest>`. Vibecore checks that `HEAD` still matches the approved
revision and that the application directory is clean before uploading. The token is
passed only through the Railway process environment and is never accepted as a flag,
stored in the plan, or written to the release ledger.

Deploy an approved Git revision to an existing DigitalOcean App Platform app:

```sh
pnpm vibe deploy digitalocean \
  --application api \
  --environment staging \
  --revision <full-current-git-sha> \
  --app-id <digitalocean-app-id> \
  --repository owner/repository \
  --branch main \
  --health-url https://api.example.com/health
```

The app must already use that GitHub repository and branch with deploy-on-push
disabled. Review the plan, export `DIGITALOCEAN_ACCESS_TOKEN`, and repeat with
`--apply --approve <digest>`. Vibecore verifies local `HEAD`, the clean application
path, and the remote branch revision before asking App Platform to deploy. The
provider deployment ID is saved in the release ledger, enabling validated historical
rollback through `vibe deploy digitalocean-rollback`.

Pin a digest on an existing image-based App Platform app:

```sh
pnpm vibe deploy digitalocean-image \
  --application api \
  --environment staging \
  --revision <git-sha> \
  --app-id <digitalocean-app-id> \
  --health-url https://api.example.com/health
```

The app must already use an image source with deploy-on-push disabled. The
application needs `config.deploymentWorkload: container` and
`config.deploymentImage` pinned with `@sha256:<digest>`.

Deploy a digest-pinned container to an existing DigitalOcean Droplet over SSH:

```sh
pnpm vibe deploy digitalocean-droplet \
  --application api \
  --environment staging \
  --revision <git-sha> \
  --droplet-id <droplet-id> \
  --host 203.0.113.10 \
  --user vibecore \
  --health-url https://api.example.com/health
```

The Droplet must already exist, be `active`, and match the approved host name or
public address. Vibecore does not create Droplets. Review the plan, export
`DIGITALOCEAN_ACCESS_TOKEN`, then repeat with `--apply --approve <digest> --ssh-key
/absolute/key/path`. The application needs `config.deploymentWorkload: container`
and `config.deploymentImage` pinned with `@sha256:<digest>`. Rollback is
`vibe deploy digitalocean-droplet-rollback`.

Deploy an approved revision to an existing Azure App Service, Container App, or
disconnected Static Web App:

```sh
pnpm vibe deploy azure \
  --application api \
  --environment staging \
  --revision <full-current-git-sha> \
  --mode app-service \
  --subscription <subscription-guid> \
  --tenant <tenant-guid> \
  --resource-group rg-app \
  --name api-staging \
  --health-url https://api.example.com/health
```

Review the plan, then repeat it with `--apply --approve <digest>` while logged in
with `az`. Vibecore checks that the Azure CLI subscription and tenant match the
plan, that `HEAD` still matches the approved revision, and that the application
path is clean. It never accepts a client secret, password, or deployment token
flag. Production additionally requires `--production-approved`.

App Service zip-deploys a `git archive` of the approved path and requires
`SCM_DO_BUILD_DURING_DEPLOYMENT=true` on the existing Linux app. Container Apps
updates a digest-pinned image in multiple-revision mode, then shifts ingress
traffic. Static Web Apps deploys a built output directory through the SWA CLI
using the current Azure identity; GitHub-connected apps must be disconnected
first. Rollback is implemented for App Service and Container Apps through
`vibe deploy azure-rollback`. Static Web Apps historical rollback is unsupported.

Deploy an approved revision to existing AWS resources:

```sh
pnpm vibe deploy aws \
  --application web \
  --environment staging \
  --revision <full-current-git-sha> \
  --mode s3-cloudfront \
  --account <12-digit-account-id> \
  --region us-east-1 \
  --bucket app-assets \
  --distribution E123456789ABCD \
  --health-url https://app.example.com/health
```

Review the plan, then repeat it with `--apply --approve <digest>` while authenticated
to the AWS CLI through SSO or a GitHub OIDC assumed role. Vibecore checks that
`sts get-caller-identity` matches the approved account, that `HEAD` still matches
the approved revision, and that the application path is clean. Access keys, secret
keys, and session tokens are never accepted as flags.

S3/CloudFront uploads a versioned `releases/<sha>/` prefix to a private bucket,
retargets the CloudFront origin path, and invalidates `/*`. App Runner and ECS
Fargate update existing services with `config.deploymentImage` pinned by
`@sha256:<digest>`. App Runner automatic deployments must already be disabled, and
Fargate services must use private subnets with a disabled public IP. Rollback is
`vibe deploy aws-rollback`.

Upload a versioned static or PHP release over SSH/SFTP:

```sh
pnpm vibe deploy shared-hosting \
  --application web \
  --environment staging \
  --revision <git-sha> \
  --mode static-sftp \
  --host host.example.com \
  --user deploy \
  --remote-root /home/deploy/site \
  --health-url https://site.example.com/health
```

Review the plan, then repeat with `--apply --approve <digest> --ssh-key /absolute/key/path`.
Files land in `releases/<sha>/`; `current` is a symlink and is never a live directory
overwrite. Rollback is `vibe deploy shared-hosting-rollback`. PHP applications use
`--mode php-sftp` and upload the application path instead of the static output
directory.

Synchronize declared secret values one environment at a time:

```sh
pnpm vibe github secrets --repository owner/repository --environment staging
pnpm vibe github secrets --repository owner/repository --environment staging --apply --approve <digest>
```

The plan contains names only. At execution time values are read from the current
process environment, preflighted before any write, and streamed to `gh secret set`
through stdin. They never appear in arguments, plans, JSON output, state, or logs.
Production additionally requires `--production-approved`.

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

Plan-first migrate, seed, backup, and restore require exact digest approval.
Destructive statements need `--allow-destructive`. Production destructive
migrations also need `--backup-checksum` from a prior `vibe db backup` and
`--production-approved`.

```sh
pnpm vibe db backup --engine postgresql
pnpm vibe db backup --engine postgresql --apply --approve <digest>
pnpm vibe db migrate --tool prisma --allow-destructive --backup-checksum <sha256>
pnpm vibe db migrate --tool prisma --allow-destructive --backup-checksum <sha256> --apply --approve <digest>
pnpm vibe db seed
pnpm vibe db restore --engine postgresql --backup .vibecore/backups/<file> --backup-checksum <sha256> --allow-destructive
```

`prisma migrate deploy`, `drizzle-kit migrate`, `typeorm migration:run`,
`mikro-orm migration:up`, and declarative MongoDB JSON operations are executed.
TypeORM requires a DataSource module (`--datasource`, default `src/data-source.ts`).
MikroORM auto-discovers its config unless `--config` is set. `schema:sync`,
`migration:revert`, and `migration:down` are not wrapped. Connection URLs stay in
the process environment; dump tools receive passwords through `PGPASSWORD` or a
mode-`0600` defaults file, never as CLI flags.

```sh
pnpm vibe db migrate --tool typeorm --datasource src/data-source.ts
pnpm vibe db migrate --tool mikro-orm --config mikro-orm.config.ts
```

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
implemented. Neon project inspect is implemented through its management API without
fetching connection strings. Authenticated create, branching, backup verification, and
deployment operations remain explicitly marked as planned.

Validate a selected stack and its environment contract without connecting to or
modifying the provider:

```sh
pnpm vibe db doctor --engine postgresql --tool prisma --provider supabase
pnpm vibe db doctor --engine postgresql --tool drizzle --provider neon
pnpm vibe db doctor --engine mongodb --tool mongoose --provider mongodb-atlas
pnpm vibe db doctor --engine redis --provider upstash
pnpm vibe db inspect-provider --provider neon
pnpm vibe db branch --provider neon --name preview-sha
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

Drizzle, TypeORM, MikroORM, Mongoose, and MongoDB migrations can be inspected
offline:

```sh
pnpm vibe db inspect-tool --tool drizzle --path drizzle
pnpm vibe db inspect-tool --tool mongodb --path migrations/mongodb
pnpm vibe db inspect-tool --tool typeorm --path src/migrations
pnpm vibe db inspect-tool --tool mikro-orm --path src/migrations
pnpm vibe db inspect-tool --tool mongoose --path migrations/mongoose
```

Drizzle inspection supports both flat `.sql` files and timestamped directories with
`migration.sql`. TypeORM and MikroORM inspection extracts `query()` / `addSql()`
SQL fragments and treats unparsed TypeScript as `review`. MongoDB and Mongoose use
ordered declarative JSON files containing an `operations` array. Supported operation
types are `createCollection`, `createIndex`, `collMod`, `renameCollection`,
`dropIndex`, `updateMany`, `deleteMany`, and `dropCollection`. Unknown operations
are blocked as destructive instead of executing arbitrary JavaScript.
