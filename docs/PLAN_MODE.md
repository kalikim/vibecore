# Plan Mode

Plan Mode creates a deterministic, local advisory report before you spend resources
on builds, previews, databases, or deployment. It is not an AI service or a cloud
cost calculator. It makes no network calls, starts no processes, installs no
dependencies, and never executes project scripts or migration commands.

```sh
vibe plan
vibe plan --environment staging --budget-conscious
vibe plan --environment production --budget-conscious --json
vibe plan --environment staging --budget-conscious --save --json
```

From the source repository, build first and invoke the CLI from your application
directory, or use the existing `pnpm vibe` development entry point.

By default, planning writes nothing. `--save` explicitly creates a private report
under `.vibecore/plans/<digest>.json`, which the repository ignores. Saving the
same report again is safe; a different file at that path is never overwritten.
Treat reports as private project metadata even though secret values are excluded.

To check a saved report, use its returned path and the same planning options:

```sh
vibe plan --environment staging --budget-conscious \
  --check .vibecore/plans/<digest>.json --json
```

Changed inputs, modified reports, mismatched options, invalid manifests, and
unsupported environments fail with a nonzero exit code. A report with blocking
environment findings also returns a nonzero exit code, while remaining reviewable.

## What the report includes

- Detected or declared application/resource counts and declared secret names only.
- Missing manifest or GitHub workflow warnings and environment/production checks.
- Read-only follow-up commands for project diagnostics, database capability
  inspection, OpenAPI adapters, Expo inspection help, and deployment support.
- Budget-conscious guidance to validate locally, avoid duplicate previews/native
  builds, and assess safe reuse of existing resources before provisioning.
- A compact, repeatable handoff for coding agents. No measured token or money
  savings are claimed.

Costs remain `unknown`. No provider prices, quotas, accounts, resource inventories,
or credentials are queried. Existing resources must still be verified for ownership,
isolation, capacity, and backup requirements before reuse.

## Advisory reports versus execution plans

This first version intentionally has no `vibe plan --apply`. An advisory report
is not an approved deployment or migration plan. Follow its inspection steps,
then generate the existing operation-specific plan and review its exact approval
digest. Production and destructive-operation safeguards remain in force.

Freshness covers the discovery fingerprint, parsed manifest, workflow presence,
and selected plan options. It does not cover every application source file, the
contents of every workflow, or any remote state. A matching report is not evidence
that a deployment is safe or current. Execution adapters must perform their own
revision, target, and approval checks.

Remaining work: richer resource-specific estimates with explicit lookup consent,
dependency-aware execution-plan composition, and verified existing-resource reuse.
