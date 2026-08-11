# Vibecore

Website: [vibecore.build](https://vibecore.build)

Vibecore is a local-first application orchestration platform for AI-assisted
developers. It coordinates the repetitive work around an application: project
discovery, local services, Git and GitHub setup, database safety, validation,
deployment, and release recovery, without replacing the frameworks developers
already use.

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
