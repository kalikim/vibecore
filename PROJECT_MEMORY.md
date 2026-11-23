# Vibecore project memory

Last inspected: 2026-11-23. Scope: this local working tree, including uncommitted
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

Root package metadata remains version `0.0.0`, `private: true`, and
`license: UNLICENSED`. Repository CI and Dependabot configuration were added locally
on 2026-11-23 under `.github/`; no GitHub run or branch-protection setup is verified.
Workflow generation for users is distinct from CI configured for Vibecore itself.

Remaining release work needs explicit acceptance evidence:

1. Review and commit the current implementation changes intentionally.
2. Exercise real reference applications through deployment, failed health checks,
   rollback, migrations, restore, and interruption recovery in scoped test targets.
3. Audit approval binding, target identity, credential handling, concurrency,
   revision verification, and failure recording across executors.
4. Run the new repository CI on GitHub, verify release artifacts, and decide a license.
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
