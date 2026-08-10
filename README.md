# Vibecore

Vibecore is a local-first application orchestration platform for AI-assisted
developers. It coordinates the repetitive work around an application—project
discovery, local services, Git and GitHub setup, database safety, validation,
deployment, and release recovery—without replacing the frameworks developers
already use.

The project is currently in its specification phase. The source of truth is:

- [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md) — product goals and v1 scope
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — system boundaries and contracts
- [`schemas/vibecore.schema.json`](schemas/vibecore.schema.json) — initial manifest schema
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — delivery phases and acceptance gates
- [`docs/adr/`](docs/adr/) — architecture decisions

## Intended experience

```sh
vibe adopt
vibe doctor
vibe dev
vibe github setup --plan
vibe deploy --environment preview
```

No CLI has been implemented yet. The next milestone is to validate the manifest
and planner contracts against reference applications before scaffolding packages.

