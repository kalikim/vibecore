# Vibecore Architecture

Status: Draft 0.1

## 1. Context

Vibecore operates between application repositories and external development or
deployment systems. It coordinates existing tools while keeping application code
portable.

```text
CLI / future UI / agent protocol
              |
       orchestration core
              |
  discovery - graph - diagnostics
  planner - policy - executor - state
              |
         adapter boundary
              |
 frameworks / resources / Git / providers / runtimes
```

The initial implementation is a modular TypeScript monolith. Packages enforce
boundaries; separately deployed services are not required for local orchestration.

## 2. Components

### Configuration

Loads `vibecore.yaml`, validates it against the versioned JSON Schema, resolves
environment overlays, and returns source locations for errors. Configuration must
not execute code.

### Discovery

Reads repository evidence and asks adapters for detection results. It does not
modify files. Conflicting high-confidence detections become diagnostics.

### Project graph

Represents applications, resources, environments, and typed dependency edges. The
graph combines declared desired state with discovered current state while retaining
their provenance.

### Diagnostics

Runs static and live checks. A diagnostic contract is:

```ts
type Diagnostic = {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  component?: string;
  evidence?: Array<{ source: string; detail: string }>;
  fix?: { adapter: string; operation: string };
};
```

### Planner

Creates an ordered directed acyclic graph of actions from desired and observed
state. Planning is read-only. Action identifiers and inputs are stable enough for
the resulting plan to be hashed.

```ts
type Action = {
  id: string;
  adapter: string;
  operation: string;
  summary: string;
  risk: "read" | "write" | "destructive";
  dependsOn: string[];
  inputs: unknown;
  permissions: PermissionRequest[];
  rollback?: { operation: string; inputs: unknown };
};
```

### Policy

Evaluates diagnostics, actions, target environment, and user-approved policy.
Policy returns allow, deny, or require-approval and provides stable reason codes.

### Executor

Executes only a validated plan. It schedules independent actions with bounded
parallelism, streams structured events, stops dependent actions after failure, and
does not automatically retry destructive actions.

### State and release ledger

Records plan digests, action outcomes, discovered provider identifiers, and release
health. State is evidence, not authority: adapters reconcile it with actual local
or remote state before material changes.

### Adapter registry

Resolves adapters by ID and capability. V1 adapters are bundled and trusted. A
future plugin host will isolate community adapters.

Database adapters use three composable layers:

- an engine adapter owns storage semantics and local runtime behavior;
- a tooling adapter owns schema, validation, and migration behavior;
- a provider adapter owns hosted provisioning, branching, backup, and connection metadata.

For example, Neon resolves as `postgresql + prisma|drizzle + neon`; Supabase resolves
as `postgresql + prisma|drizzle + supabase`. Capability support is declared as
`implemented`, `planned`, or `unsupported`, preventing detection from being mistaken
for permission to provision or deploy.

Provider configuration diagnostics are provider-neutral and read-only. Each provider
declares required connection-variable groups, optional control-plane credential
pairs, supported engines, and safe URL-shape checks. Diagnostic evidence may contain
variable names and the phrase `value redacted`, but never values.

## 3. Adapter contract

```ts
interface VibecoreAdapter {
  metadata: {
    id: string;
    version: string;
    apiVersion: "v1alpha1";
    capabilities: string[];
  };

  detect?(context: DetectionContext): Promise<DetectionResult>;
  validate?(context: ValidationContext): Promise<Diagnostic[]>;
  observe?(context: ObservationContext): Promise<ObservedState>;
  plan?(context: PlanningContext): Promise<ActionProposal[]>;
  execute?(action: ApprovedAction, context: ExecutionContext): Promise<ActionResult>;
}
```

Adapters cannot mutate during `detect`, `validate`, `observe`, or `plan`. Execution
receives only the permissions granted for the approved action.

## 4. Plan lifecycle

```text
draft -> validated -> policy checked -> approved -> executing
      -> succeeded | failed | interrupted | reconciliation required
```

A plan contains:

- schema and tool versions;
- repository revision and dirty-state fingerprint;
- target environment;
- ordered actions;
- redacted input summary;
- policy decisions;
- creation time and digest.

Before execution, Vibecore verifies that relevant repository inputs have not
changed. A stale plan must be regenerated.

## 5. Configuration resolution

Resolution order, lowest to highest priority:

1. manifest defaults;
2. named environment configuration;
3. non-secret CLI overrides;
4. runtime secret references resolved by the selected secret source.

Unknown fields are rejected in the stable schema. Adapter configuration is
validated by the selected adapter's own schema.

## 6. Secret model

The manifest contains references, never values:

```yaml
variables:
  DATABASE_URL:
    secret: true
    sources:
      dev: env-file
      staging: github-environment
      production: github-environment
```

Secrets are resolved as late as possible and passed only to the action requiring
them. Logs pass through structural and value-based redaction. State stores the
secret name, source, and optional version identifier—not its value.

## 7. Process and command model

Commands use structured execution:

```ts
type CommandSpec = {
  executable: string;
  args: string[];
  cwd: string;
  envRefs: string[];
  timeoutMs?: number;
};
```

Adapters may not provide an arbitrary shell string. Interactive commands are
disallowed unless the action explicitly declares interaction support.

## 8. Local runtime

The runtime maintains a session containing allocated ports, child process IDs,
container identifiers, health state, and log streams. Cleanup is restricted to
resources bearing the current session identity.

Docker Compose is the V1 resource runtime. Application processes may run directly
for fast reload while PostgreSQL and Redis run as containers.

## 9. Persistence layout

```text
.vibecore/
  state.json       # non-secret local state
  plans/           # redacted plan artifacts
  logs/            # local structured execution logs
  sessions/        # active development session metadata
```

Only stable project configuration is committed. Runtime state, plans, and logs are
ignored by default. A future SQLite implementation may replace JSON without
changing public contracts.

## 10. Package boundaries

```text
apps/cli                 command parsing and human presentation
packages/config          manifest parsing and schema validation
packages/project-graph   graph types and construction
packages/diagnostics     diagnostic contracts and rendering
packages/planner         action graph generation and hashing
packages/policy          safety decisions
packages/executor        approved action scheduling
packages/state           state and release storage
packages/adapter-sdk     public adapter contracts
adapters/*               framework and provider behavior
```

The CLI may depend on all orchestration packages. Core packages must not depend on
the CLI or concrete adapters. Concrete adapters depend on `adapter-sdk`, not core
implementation internals.

## 11. Testing strategy

- Contract tests for manifest, diagnostic, plan, and adapter schemas.
- Unit tests for graph ordering, plan hashing, policy, and redaction.
- Fixture repositories for every supported framework combination.
- Adapter conformance suite enforcing read-only planning.
- Integration tests using temporary Git repositories and Docker resources.
- Golden plan tests to detect accidental action changes.
- End-to-end reference applications for local, preview, and production workflows.
- Fault injection for interrupted deploys, failed migrations, and unhealthy releases.

## 12. Compatibility

The manifest has an API version independent of CLI package versions. Adapters also
declare an adapter API version. Breaking manifest changes require conversion tooling
and a new API version; deprecated fields receive at least one supported migration path.
