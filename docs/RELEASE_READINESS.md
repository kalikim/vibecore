# Release readiness

Vibecore is an integration-stage CLI, not a completed production release. This
checklist separates repeatable local evidence from live-provider acceptance.

## Reproduce the local gate

Use Node.js 22 or 24 and the pnpm version pinned in `package.json`:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test:package
```

`check` compiles the workspace, runs the unit/integration suite, and invokes the
compiled CLI in disposable projects. Runtime tests bind loopback ports. A sandbox
that prohibits listening cannot run the complete suite.

`test:package` creates a temporary production-only installation with `pnpm deploy`,
checks that its symlinks remain inside that installation, and repeats the CLI
tests against that entry point. Deployment here means local package assembly,
not a cloud deployment. It runs offline after dependencies are installed and
removes only its own temporary directory. It does not publish to npm.

Package file allowlists include compiled output and the config package's schema,
excluding compiled tests. `schemas/vibecore.schema.json` remains authoritative;
`scripts/prepare-assets.mjs` copies it into the package before compilation.
Do not edit the generated copy under `packages/config/schemas/`.

The repository CI runs these gates on Node.js 22 and 24. Actions are commit-pinned,
checkout does not persist credentials, and token permissions are read-only.
No cloud credentials, deployment jobs, or publication credentials are required.
Adding the workflow locally does not establish that GitHub has run it: commit,
push, and review the actual checks before calling CI operational.

## Acceptance gates

<table>
  <thead><tr><th>Gate</th><th>Required evidence</th></tr></thead>
  <tbody>
    <tr><td>Local quality</td><td>Typecheck, existing tests, CLI exit/JSON/approval tests, and portable installation test pass from a clean checkout.</td></tr>
    <tr><td>Repository CI</td><td>Both Node matrix jobs pass on GitHub. Configure branch protection separately.</td></tr>
    <tr><td>Live operations</td><td>Approved test targets demonstrate deployment, failed health checks, supported rollback, migrations, backup/restore, and interruption recovery. Mocked runners are insufficient.</td></tr>
    <tr><td>Security review</td><td>Audit target identity, exact-plan approvals, stale revisions, secret handling, concurrent execution, and failure recording across every executor.</td></tr>
    <tr><td>Distribution</td><td>Choose a license, package name/version and publication policy; verify the actual release artifact. Packages remain private and UNLICENSED until that decision.</td></tr>
    <tr><td>Capability promises</td><td>Document unsupported provider modes, manifest-only blueprints, and Expo asynchronous completion limits. Keep MCP, team dashboard, and isolated plugins marked as future work.</td></tr>
  </tbody>
</table>

## Next implementation work

The file ledger serializes cooperating writers with a repository-local directory
lock and atomic file replacement. Reconciliation commits its selected records in
one compare-and-swap transaction after health checks, preserving unrelated entries
and rejecting concurrent changes. Duplicate starts of an executing plan are refused.

Lock acquisition times out after five seconds. A crashed writer can leave
`.vibecore/state.lock`; it is never reclaimed automatically. Confirm no Vibecore
writer is active before manually removing that empty directory. This is local
ledger coordination, not a distributed cloud-operation lock or protection against
a malicious process running as the same user. Release updates require the expected
previous snapshot and cannot change release identity. Rollback commits validate
the failed and target snapshots and record both ledger changes atomically.
Atomic replacement is not a guarantee against power-loss data loss.

Mutating deployment/Expo CLI commands, health verification, and applied
reconciliation also acquire `.vibecore/deployment.lock` for the command lifetime.
This conservative repository-wide lease rejects overlaps immediately, including
different application names that may point at the same resource. Read-only
discovery and planning remain available. The lease is released on normal completion
or handled errors; abrupt termination can leave it behind. Inspect remote state
and confirm no active writer before manually removing an abandoned lock.
This is not a distributed lock: another checkout, another machine, direct library
calls, and asynchronous provider operations after the CLI exits are not covered.
`deploy verify-health` only accepts a deploying release and will not reopen a
completed or rolled-back release.

## Inspecting interrupted commands

`vibe history` and `vibe history --json` include deployment command attempts.
The CLI writes a `running` entry after acquiring its deployment lease and before
running the command handler. Normal completion records `command-completed` or
`command-failed` plus the exit code. These entries include preflight/approval
failures, not just operations that reached a provider. They store command names
and timestamps, never arguments, credentials, URLs, or raw error output.

`remoteOutcome` deliberately remains `unverified`, even after exit code zero.
An abrupt stop leaves `running` evidence; it does not prove the remote operation
stopped. If completion recording fails, the CLI retains the deployment lease.
Legacy state files without attempts remain readable, and unrelated ledger updates
preserve existing attempts. Attempt history is not automatically pruned yet.

Before retrying an interrupted operation, inspect the local history, confirm the
writer is no longer active, and inspect the actual provider target and revision.
Do not infer remote failure from a local timeout or remove a lock just to retry.
Provider-specific recovery, linking attempts to verified resource/release IDs,
and an approved resolution workflow are still pending. The current journal does
not automatically resume, undo, or reconcile remote operations, and does not
guarantee persistence through power loss.

Audit executor approval/identity boundaries and add regression tests for gaps
before expanding mutating integrations. Live acceptance must use explicitly
approved test resources, not the production website VM by default. A successful
health endpoint or CLI exit alone is not evidence of the intended deployed revision.

The platform can reach a bounded v1 before every future adapter or dashboard is
built. Release acceptance requires evidence for the supported scope, not a
percentage estimate or a larger provider list.
