# ADR 0002: Use a declarative, versioned YAML manifest

Status: Accepted

## Context

Vibecore needs a reviewable source of desired state usable by humans, CI, and AI
tools. Executable configuration would make planning and security analysis harder.

## Decision

Use `vibecore.yaml`, validated by JSON Schema, with an explicit `apiVersion` and no
executable code. Provider-specific details live under adapter-owned `config` fields.

## Consequences

Configuration is portable and statically analyzable. Advanced dynamic configuration
must use generated manifests or explicit overlays rather than arbitrary code.

