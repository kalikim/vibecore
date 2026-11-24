# Vibecore project memory

Last inspected: 2026-11-24. Scope: this local working tree, including uncommitted
and untracked implementation files. This is a handoff document, not proof of a
published release or a live deployment. Recheck it against code before acting.

## Start here

Vibecore is a local-first CLI for adopting, checking, running, and deploying
applications through reviewable plans. It composes existing frameworks, databases,
cloud tools, and Expo EAS. The public website belongs to the separate private
`../vibecore-site` repository; do not move it into this public repository.

Read this file, `docs/ROADMAP.md`, and the relevant source before continuing.
Run `git status --short` first and preserve existing changes. Many files were
modified or untracked during this inspection; do not equate local availability
with committed, pushed, packaged, or deployed availability.

## Evidence-based build stage

The project is an integration and hardening-stage prototype with broad CLI coverage.
Previous chat estimates such as "68% complete" were subjective and are stale.
Do not report a new percentage without defining and checking acceptance criteria.

- CLI entry point: `apps/cli/src/index.ts`. Includes adopt, doctor, init, dev,
  history, reconcile, database operations, API documentation, GitHub, Expo, and deploy.
- Azure and AWS execution and rollback functions exist in
  `packages/deployment/src/azure.ts` and `aws.ts`, with runner-based tests.
- Deployment modules also exist for self-hosted Docker, Railway, DigitalOcean,
  Droplets, shared hosting, and Vercel. Inspect each mode's implementation;
  provider registration alone does not establish operational support.
- Database migration, seed, backup, and restore functions exist in
  `packages/database/src/operations.ts`. Hosted-provider inspection and Neon
  branch operations exist in `providers.ts`; this is not universal provisioning.
- `packages/discovery/src/blueprints.ts` and `vibe init` generate a manifest.
  They do not scaffold complete application source code.
- `packages/deployment/src/expo.ts` wraps EAS build, update, and submit.
  Build uses `--no-wait`; submission uses `--latest`. A successful command does
  not prove a native build completed or an app store accepted the release.
- `packages/deployment/src/reconcile.ts` repairs local ledger entries and can
  recheck an endpoint. It does not establish complete provider-state recovery.
- OpenAPI discovery and scaffolding live in `packages/api-docs`; generated docs
  still need review for business semantics and route coverage.

## Verification and release gaps

Inspection on 2026-11-22: TypeScript passed. The sandbox test run passed 150 of
152 tests; two runtime tests failed to bind local ports. An approved rerun outside
the sandbox passed all 152 tests across 37 files, confirming the binding failures
were specific to the restricted execution environment.
Deployment tests use injected runners and mocked HTTP responses. These establish
tested code paths, not successful live cloud deployments or security certification.

Root package metadata is version `0.1.0-alpha.1`, `private: true`, and
`license: MIT` following the user's explicit license choice. Repository CI and Dependabot configuration were added locally
on 2026-11-23 under `.github/`; no GitHub run or branch-protection setup is verified.
Workflow generation for users is distinct from CI configured for Vibecore itself.

Remaining release work needs explicit acceptance evidence:

1. Review and commit the current implementation changes intentionally.
2. Exercise real reference applications through deployment, failed health checks,
   rollback, migrations, restore, and interruption recovery in scoped test targets.
3. Audit approval binding, target identity, credential handling, concurrency,
   revision verification, and failure recording across executors.
4. Run the new repository CI on GitHub, verify release artifacts, and finalize publication metadata/authentication. MIT is selected.
5. Clarify blueprint scope, Expo completion tracking, and unsupported provider modes.
6. Treat MCP/editor adapters, community plugin isolation, and a team dashboard as
   future work until their implementation and tests are found.

## Working rules for humans and coding assistants

- Code and reproducible checks take precedence over this memory, roadmap claims,
  marketing text, and previous chat answers. Explain discrepancies explicitly.
- Distinguish planned, implemented, unit-tested, integration-tested, and deployed.
- Never invent a command, flag, result, deployment URL, provider capability, or
  completed background task. Check CLI help and current vendor documentation.
- A digest or HTTP 200 alone does not prove the intended revision was deployed.
- Keep secrets, tokens, connection strings, private keys, raw logs, and customer
  data out of memory, plans, examples, and committed files.
- Preserve production approval and plan-digest boundaries. Authenticated sessions
  do not automatically authorize creating paid resources or deploying changes.
- Use dev, staging, and production as explicit environments.
- Keep documentation tables in HTML; avoid white headers where styling is supported.
  GitHub may strip inline styles. Avoid em dashes in README copy.

## Updating this memory

### Alpha commit and publication attempt, 2026-11-24

Release commit `120fd84` was pushed to main. GitHub run 45386146699 passed core
and portable-install tests on Node 22/24 but failed tarball tests: Corepack chose
pnpm 12 in the unpinned temporary consumer, ignoring pnpm 10 override settings.
Fixed by inheriting the root packageManager in that consumer. Publication remains
pending a successful CI rerun; no package was published during this failure.

User authorized committing and publishing the prepared alpha. npm authentication
is verified; organization listing alone did not establish publishing permission.
Release files passed diff whitespace checks and a targeted credential-pattern
scan returned no matches (not a full security audit). Prior full alpha validation
passed as recorded below. Commit/push, remote CI, and npm publication outcomes
must be checked before reporting the release as available. No private-site files
are included. Production readiness limitations remain unchanged.

### Alpha release metadata preparation, 2026-11-24

Prepared all 16 workspace packages as `0.1.0-alpha.1`, non-private, with explicit
public access, alpha tag, npm registry, Node >=22 requirement, and repository
subdirectory metadata. Root remains private. CLI version is now read from its
package.json; tests assert the alpha version. Tarball verification checks root
privacy, the 16-package publication set, publish metadata, and exact internal
dependency versions after packing. Added CLI package README and
`docs/PUBLISHING.md`; refreshed release-readiness and Nginx source-access wording.
Preserved all prior user changes; no files staged or committed.
Checks passed: frozen offline installation (lockfile unchanged), `pnpm check`
(196 unit tests and 10 CLI tests), `pnpm test:package`, `pnpm test:tarballs`
(16 archives and installed CLI), `pnpm test:nginx`, and diff check.
User reports npm login and access under @vibecore; not independently reverified
this turn. No npm publication, Git push, or deployment performed. Next: review and
commit the release changes, verify remote CI and registry permissions, publish
with the alpha tag, and verify every version plus a clean registry CLI install.
Production server activation/certificate lifecycle and live-provider acceptance
remain incomplete; alpha packaging does not establish production readiness.

### MIT licensing and actual package archive verification, 2026-11-23

User explicitly selected MIT. Added root `LICENSE` with attribution to Vibecore
contributors and MIT metadata in the root and all 16 workspace package manifests.
Build preparation copies the canonical license into each package; generated copies
are ignored by Git. The private website repository was not changed or relicensed.
Added `scripts/verify-tarballs.mjs` and `pnpm test:tarballs`: creates actual archives,
checks allowed paths/license/schema/workspace dependency rewriting, installs them
offline into a temporary consumer, and runs all 10 CLI tests plus the installed
`vibe` executable. Internal dependencies use local tarball overrides and external
versions match the source lockfile. This verifies archive installation, not npm
registry availability. Temporary artifacts are removed after checks. Initial
offline resolution failures were fixed with those explicit overrides.
CI now includes tarball checks; remote execution remains unverified.
Checks passed: `pnpm check` (196 unit tests, 10 CLI tests), `pnpm test:package`,
`pnpm test:tarballs` (16 packages, 10 CLI tests), `pnpm test:nginx`, and diff check.
Read-only `npm whoami` returned ENEEDAUTH; no npm session is available. Never request
tokens in chat. Packages remain private at 0.0.0; scope ownership, release version,
publication policy, and live acceptance gates remain unresolved. No commit, push,
publication, or deployment. Next: server activation/recovery and reference-app
acceptance; configure authenticated publishing and release metadata separately.

### Real Nginx integration gate, 2026-11-23

Added `scripts/verify-nginx.mjs` and `pnpm test:nginx`. The exact generated candidate
now passes real Nginx syntax and runtime checks in a disposable, digest-pinned
container with a synthetic loopback upstream and one-day test certificate. Tests
verify certificate trust/hostname, fixed-host redirects, forwarding-header
replacement, dot/dependency-path denial, body-size limits, invalid-config rejection,
continued service after a failed reload, observable valid reload, and restoration.
The test runs as the invoking UID/GID, drops capabilities, mounts fixtures read-only,
and publishes random loopback-only ports. It deletes only its own container and
temporary fixtures; early permission failures were fixed and fixtures cleaned up.
The image is a test fixture, not a production recommendation. No live VM contacted.
CI's Node 24 job now includes this gate; no remote CI result is verified.
Checks passed: `pnpm test:nginx`, `pnpm check` (196 unit tests and 10 CLI tests),
`pnpm test:package` (10 isolated-install CLI tests), and `git diff --check`.
Updated README, `docs/NGINX.md`, and release-readiness instructions. This supersedes
the earlier absence of real Nginx validation, but does not implement privileged
server activation, certificate renewal, or automatic deployment rollback. Next:
approval-bound server activation and recovery, live reference-app acceptance, and
release metadata/publication. License choice requested from user and still pending.
No commit, push, publication, or production deployment performed.

### Nginx candidate generation, 2026-11-23

Added read-only `vibe deploy nginx --domain <hostname> --port <port> [--json]`
in the CLI and `packages/deployment/src/nginx.ts`. Validates DNS/port inputs,
generates a deterministic digest and HTTPS reverse-proxy candidate for an existing
certificate, and provides limitations and a manual activation checklist. Uses a
fixed redirect host, loopback upstream, replaced forwarding headers, TLS 1.2/1.3,
body/time limits, and dot/dependency-path blocking. No writes or server calls.
Documentation: `docs/NGINX.md` and README. Checks: `pnpm check` passed TypeScript,
196 unit tests across 39 files and 10 CLI smoke tests; `pnpm test:package` passed
all 10 smoke tests in an isolated production install. `git diff --check` passed.
Nginx is not installed locally, so generated configuration was not validated with
the actual Nginx binary or a live host. Certbot lineage paths are assumptions.
Certificate lifecycle, server inspection, privileged activation, locking, rollback,
and health verification are not implemented. Existing private-site deployment
script remains unsafe to reuse unchanged. No commit, push, npm publication, or
live deployment. Next: isolated Nginx integration tests and approval-bound server
activation with backups/rollback; finish release gates before npm publication.

### Website production publication, 2026-11-23

Built the private `vibecore-site` frontend and published its static export to
the existing Azure VM's `/var/www/vibecore`, including guided onboarding, terminal
animation, expanded feature copy, and GTM markup. Preserved Nginx/Certbot settings;
did not run the old deployment script because it overwrites HTTPS configuration.
Backup: `/home/vibecore/site-backup-rc6M3m` on the VM. Old static assets retained.
Public HTTPS HTML and the VM index matched the local build SHA-256; HTTP redirects
to HTTPS and Nginx validation passed. Initial Node fetch timed out; curl succeeded.
No npm publication or Git push. Analytics collection and browser interactions
remain unverified. Update the legacy deployment script before reusing it.

### Private-site guided onboarding and terminal demo, 2026-11-23

Added `GettingStarted.tsx`, `TerminalDemo.tsx`, and scoped `onboarding.css` to
`../vibecore-site/app`; updated landing navigation and hero CTA. The prompt uses
source checkout/build, checks available CLI commands, preserves user changes,
and requires approval before local startup or mutations. Source instructions run
the built entry point from the user's app directory via a session-local function.
The site distinguishes source evaluation from production readiness and removes
the unimplemented MCP configuration example. GIF-style animation uses CSS rather
than an image, pauses offscreen/in hidden tabs, includes a pause control, and has
a static reduced-motion/no-JavaScript fallback. Copy failure selects the prompt
for manual copying. Existing analytics and other site edits are preserved.
Verification: core `pnpm check` and isolated-install checks passed; frontend
typecheck, production build, diff check, and exported-content checks passed.
Browser interaction/visual QA was not performed. No commit, push, or deployment.
Next: browser-check copying and animation on desktop/mobile, then deploy only the
intended site changes while preserving live HTTPS configuration.

### Private website analytics, 2026-11-23

Added a production-only Google Tag Manager bootstrap and noscript fallback in
`../vibecore-site/app/layout.tsx`, preserving existing frontend edits. No tracking
was added to the public CLI. Frontend typecheck/build and diff checks passed;
export inspection and a mocked-DOM script check verified one async loader and
preservation of an existing dataLayer. No live tracking request was sent. Not
deployed, and GTM container publication, analytics destinations, and consent
configuration were not inspected. Next: publish the intended private-site changes
without overwriting Certbot configuration, then verify with Tag Assistant.

### Resource-conscious Plan Mode, 2026-11-23

`vibe plan` now generates a deterministic advisory report using local repository
discovery, an optional validated manifest, workflow presence, and dev/staging/
production selection. `--budget-conscious` adds resource-saving guidance;
`--json` provides reusable agent context. No network/AI calls, processes, installs,
provisioning, or migrations are run by the command. Default operation writes
nothing; `--save` explicitly stores a private digest-named report in ignored
`.vibecore/plans`. `--check <path>` verifies integrity and current inspected inputs
with the same options, failing on stale/tampered reports. Storage rejects symlinks
and conflicting files. Raw config/secret values and parser excerpts are excluded.
Sources: `packages/planner/src/resource-plan.ts`, CLI plan handler, and
`docs/PLAN_MODE.md`. Validation passed TypeScript, 176 tests across 38 files, nine
CLI tests, isolated-install checks, and `git diff --check`.
Limits: advisory reports are not executable approval plans; no unified apply yet.
Prices/quotas and existing cloud resources are not verified; cost stays unknown.
Freshness covers discovery inputs, parsed manifest, workflow presence, and options,
not all source files or remote state. Token/cost savings are not measured. Next:
compose operation-specific plans and explicit-consent resource inspection while
preserving existing approval gates. No commit, push, publication, or deployment.

### Deployment command-attempt journal, 2026-11-23

Added optional `DeploymentAttempt` records to the state contract for compatibility
with older ledgers. `FileStateStore` persists running attempts and conditionally
records CLI completion/failure, preserving unresolved entries across other writes.
The CLI journals commands protected by its deployment lease before their handler
runs, including preflight failures, and exposes attempts via human/JSON history.
Only command names, timestamps, IDs, statuses, and exit codes are stored; no raw
arguments or errors. Remote outcome always remains unverified. Failed completion
recording retains the lease. An abrupt-termination subprocess regression confirms
running evidence and the lock survive process death.
Validation: TypeScript, 170 tests across 37 files, seven CLI smoke tests, isolated
production-install checks, and `git diff --check` passed. No cloud calls, commit,
push, or deployment were performed. Limits: not power-loss durability, no attempt
pruning, no automatic interruption resolution, no verified resource/release linkage,
and no provider recovery. Next: bind attempts to verified executor plan/target
identities and add a read-only provider outcome inspection path before allowing
approved recovery or retries. Do not call command completion deployment success.

### Release updates and deployment exclusion, 2026-11-23

`FileStateStore.updateRelease` now requires an unchanged expected snapshot and
preserves immutable release identity. `commitRollback` verifies failed/target
snapshots and atomically updates the failed record and inserts the rollback record.
All seven CLI rollback handlers use it. Health verification uses conditional
updates and refuses completed/rolled-back releases. The CLI acquires a conservative
repository-wide `deployment.lock` around mutating deployment/Expo commands, health
verification, and applied reconciliation. Read-only plans/discovery do not lock.
Tests cover stale updates, identity changes, rollback atomicity/collisions, lease
contention, and CLI lock cleanup. This is not distributed target exclusion and
does not wrap direct executor library calls or asynchronous provider work after
CLI exit. Interrupted locks require manual inspection; no automatic reclamation.
Validation: `pnpm check` passed TypeScript, 166 tests across 37 files, and seven
CLI subprocess tests. `pnpm test:package` passed the same seven CLI tests in an
isolated production install. `git diff --check` passed.
Next: durable deployment-attempt/failure records and provider-state recovery,
followed by explicitly approved live acceptance targets. No commit, push, or deploy.

### Local ledger concurrency, 2026-11-23

`packages/state/src/index.ts` now locks the read-modify-write cycle across local
processes, uses unique temporary filenames, and refuses duplicate starts of an
executing plan. `compareAndSwapRecords` validates selected snapshots and commits
all replacements together without overwriting unrelated records. CLI reconciliation
uses this transaction after its health checks instead of separate per-record writes.
Independent-store and separate-Node-process tests verify concurrent records survive;
regressions cover stale snapshots, all-or-nothing changes, and lock cleanup on errors.
Final validation: `pnpm check` passed TypeScript, all 162 tests across 37 files,
and four CLI tests. `pnpm test:package` passed isolated-install checks and the same
four CLI tests. `git diff --check` passed. The lock-timeout regression confirmed
that an existing lock is retained without state writes.
The lock is for cooperating local writers only, with a five-second timeout and no
automatic stale-lock removal. Conditional release updates and local CLI deployment
exclusion were added in the subsequent milestone above; distributed exclusion,
power-loss durability, and wider executor auditing remain unfinished.

### Core release gate and reconciliation hardening, 2026-11-23

- `.github/workflows/ci.yml` adds read-only, commit-pinned validation on Node 22/24;
  `.github/dependabot.yml` covers Actions and npm updates. Not pushed or run remotely.
- `pnpm check` now includes compiled CLI subprocess tests (`tests/cli.smoke.mjs`).
  Tests cover help/errors, read-only JSON discovery, exact-approved init, refusal
  to overwrite an existing manifest, and schema validation outside the checkout.
- `pnpm test:package` assembles an offline production install in a disposable
  directory, rejects external symlinks, and reruns the CLI tests there. Package
  file allowlists exclude compiled tests. The canonical schema is copied into
  the config package by `scripts/prepare-assets.mjs`; it no longer relies on a
  source-checkout-relative lookup. pnpm portable deployment mode is configured.
- A clean temporary source copy with no build output or node_modules passed
  frozen offline installation, all 152 then-existing tests, CLI tests, and isolated
  package tests on local Node 24. Node 22 execution remains for CI to verify.
- Reconciliation now hashes the selected ledger records into its approved plan,
  rejects changed/missing/duplicate targets, and only health-checks approved
  release IDs. Four new regressions raise the unit suite to 156 passing tests.
  Cross-process locking and reconciliation compare-and-swap were added in the
  subsequent local-ledger milestone above.
- See `docs/RELEASE_READINESS.md` for remaining evidence gates. Next: audit the
  remaining executor boundaries and state concurrency, then exercise approved
  live test resources. No cloud deployment, package publication, commit, or push
  was performed in this milestone. The license decision remains outstanding.

### Website coverage update, 2026-11-23

Updated the separate private `../vibecore-site/app/page.tsx` and `app/globals.css`
to describe local runtime, database operations, GitHub environments and secret
synchronization, OpenAPI, Expo EAS, release recovery, and the memory-file pattern.
Deployment comparison distinguishes implemented execution from provider-specific
rollback limits. Hosted database diagnostics are distinguished from Neon API
inspection/branch creation and unimplemented universal provisioning. Evidence:
CLI command definitions and database/deployment source modules. Preserved existing
frontend edits. Typecheck and production static build passed; no browser visual
verification or deployment performed for this content update. Next: preview the
expanded page and publish the private site while preserving Certbot's live Nginx
configuration. Core platform functionality was not changed.

After a material change, record the date, concrete behavior, source paths, tests
actually run, limitations, and next work. Remove superseded claims. Keep entries
short and never label mocked execution as a real deployment.

For a new project using Vibecore, create its own PROJECT_MEMORY.md containing:

- Purpose, users, and chosen stack.
- Entry points and commands verified in that project.
- Database and environment contracts using secret names only.
- Decisions and their reasons.
- Implemented behavior versus planned behavior.
- Latest verification results, known limitations, and the next task.

A Markdown file supplies persistent context only when a person or assistant reads
it. It reduces repeated guesses; it does not prevent hallucinations by itself.
