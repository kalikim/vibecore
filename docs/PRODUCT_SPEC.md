# Vibecore Product Specification

Status: Draft 0.1  
Last updated: 2026-08-10

## 1. Product statement

Vibecore is an open, local-first application operations layer for developers who
build with AI assistance. A developer describes an application once, and
Vibecore detects, validates, runs, and ships the connected parts through explicit,
reviewable plans.

Vibecore is not a web framework, ORM, cloud provider, or autonomous code-writing
agent. It composes those tools and gives them a consistent safety model.

## 2. Problem

AI-assisted developers can generate features quickly, but still face fragmented
operational work:

- repositories and CI are configured inconsistently;
- environment variables drift between local, preview, and production;
- schema migrations can destroy data;
- web, API, worker, and mobile projects use disconnected workflows;
- provider setup is difficult to reproduce;
- failures are often discovered only after deployment;
- generated fixes are difficult to audit or reverse.

The result is a gap between generating an application and operating one safely.

## 3. Target users

### Primary

- Solo and small-team developers building web or Expo applications with AI tools.
- Developers who can edit code but do not want to become infrastructure experts.
- Agencies that repeatedly create similar full-stack application foundations.

### Secondary

- Experienced developers who want reproducible project and deployment automation.
- Platform teams that want shareable blueprints and policy packs.

## 4. Product principles

1. **Local-first.** Core workflows work without a Vibecore account.
2. **Plan before apply.** Material mutations have a reviewable plan.
3. **Adopt before generate.** Existing applications remain first-class.
4. **Ordinary files.** Users retain understandable source and provider config.
5. **Provider adapters.** Provider behavior does not leak into the core model.
6. **Safe defaults.** Production and destructive database actions require stronger checks.
7. **Agent-readable.** Diagnostics and plans have stable JSON representations.
8. **Escape hatches.** Unsupported provider features remain accessible directly.

## 5. Vocabulary

- **Application:** An executable unit such as a web app, API, worker, or mobile app.
- **Resource:** Infrastructure or a managed dependency such as SQL, cache, or storage.
- **Environment:** A named desired deployment context such as local or production.
- **Adapter:** An integration implementing framework, resource, runtime, or provider capabilities.
- **Project graph:** Vibecore's discovered model of applications and their dependencies.
- **Plan:** An immutable, ordered set of proposed actions.
- **Action:** One bounded, auditable operation with inputs, risk, and expected result.
- **Release:** A recorded deployment attempt for one environment.
- **Blueprint:** A reusable application manifest and optional starter files.

## 6. V1 supported path

V1 optimizes one cohesive stack:

- pnpm workspace;
- Next.js web application;
- Expo mobile application;
- Hono API running on Node.js;
- PostgreSQL with Prisma;
- Docker Compose local resources;
- Git and GitHub Actions;
- Vercel web deployment;
- self-hosted Docker API deployment;
- Expo EAS build and update orchestration.

Other tools may be detected, but unsupported tools must produce honest diagnostics
rather than partial or invented configuration.

## 7. Required workflows

### 7.1 Initialize and adopt

`vibe init` creates a manifest from a supported blueprint. `vibe adopt` scans an
existing repository and proposes a manifest. Adoption does not modify application
source until its plan is applied.

Acceptance criteria:

- identify package manager and workspace layout;
- detect supported applications, Prisma, and Docker configuration;
- report conflicting or ambiguous discoveries;
- emit a valid `vibecore.yaml` proposal;
- preserve existing scripts and configuration by default.

### 7.2 Diagnose

`vibe doctor` evaluates the project, environment, resources, and deployment
readiness. Every diagnostic contains a stable code, severity, evidence, affected
component, and optional fix reference.

Output modes:

```sh
vibe doctor
vibe doctor --json
vibe doctor --environment production
```

### 7.3 Develop locally

`vibe dev` resolves dependencies, validates configuration, starts local resources
and applications, aggregates logs, and reports health. Shutdown must stop only
processes started by the current Vibecore session.

### 7.4 Database operations

Vibecore wraps Prisma rather than replacing it:

```sh
vibe db inspect
vibe db diff
vibe db migrate --plan
vibe db seed
vibe db backup
vibe db restore
```

Schema changes are classified as safe, review-required, destructive, or blocked.
Production destructive changes require an explicit override and a verified backup
policy.

### 7.5 Git and GitHub

Vibecore can initialize Git, create repository conventions, propose GitHub Actions,
and configure repository environments. Remote mutations are opt-in and planned.
Secret values are never accepted into a plan artifact.

### 7.6 Deploy and recover

The standard deployment lifecycle is:

```text
discover -> validate -> test -> build -> migration check -> infrastructure plan
         -> approval -> deploy -> health check -> record release
```

`vibe rollback` uses the deployment adapter's recovery mechanism and records a new
release event. It must never claim rollback support if an adapter cannot provide it.

### 7.7 Expo

Vibecore coordinates EAS configuration, build profiles, update channels,
environment contracts, deep links, API endpoints, and native readiness. It does
not implement a native build service.

## 8. Local and offline behavior

V1 defines two modes:

- **Offline-capable development:** previously installed dependencies and images can
  run without a network connection; local resources do not require cloud services.
- **Self-hosted deployment:** an application can deploy to a user-controlled Linux
  host through Docker without a Vibecore account.

Air-gapped first installation is outside V1 because it requires an artifact mirror
or distribution bundle.

## 9. Safety requirements

- Plans are immutable after approval and include a content digest.
- Secret values are redacted at collection and execution boundaries.
- Shell commands are represented as executable plus argument arrays.
- Actions declare filesystem, network, process, and secret permissions.
- Production is never inferred from the current branch alone.
- Destructive actions cannot be silently retried.
- Generated file edits include a diff or complete proposed content.
- Interrupted plans can be inspected and reconciled.
- State records do not become the only proof of real provider state.

## 10. Non-goals for V1

- Replacing application frameworks, Prisma, Terraform, Docker, or EAS.
- Supporting every cloud or JavaScript framework.
- Kubernetes orchestration.
- A general-purpose AI coding agent.
- A proprietary application runtime.
- Perfect equivalence between providers.
- An app-store submission service.
- Air-gapped dependency installation.

## 11. Success metrics

- A supported repository is adopted in less than two minutes after dependencies exist.
- A reference application reaches a healthy local state in less than five minutes.
- Plans and logs contain zero known secret values in automated security tests.
- Preview CI can be configured with one planned workflow.
- Every production deployment has a durable release record and health result.
- Common configuration failures are detected locally before CI.
- Removing Vibecore leaves an operable, understandable application repository.

## 12. Open product questions

- Which portions of the future hosted control plane are commercial?
- Should `vibe init` initially generate applications or only compose upstream starters?
- Which self-hosted target is the reference: plain Docker context, SSH host, or both?
- How are community adapters reviewed, signed, and sandboxed?
- When should reusable blueprints become stable public API?

