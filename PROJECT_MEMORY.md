# Vibecore project memory

Last inspected: 2026-11-22. Scope: this local working tree, including uncommitted
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
`license: UNLICENSED`. No root `.github` directory was found during inspection.
Workflow generation for users is distinct from CI configured for Vibecore itself.

Remaining release work needs explicit acceptance evidence:

1. Review and commit the current implementation changes intentionally.
2. Exercise real reference applications through deployment, failed health checks,
   rollback, migrations, restore, and interruption recovery in scoped test targets.
3. Audit approval binding, target identity, credential handling, concurrency,
   revision verification, and failure recording across executors.
4. Establish repository CI, packaging/install verification, and a license decision.
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
