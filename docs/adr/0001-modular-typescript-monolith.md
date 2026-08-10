# ADR 0001: Begin as a modular TypeScript monolith

Status: Accepted

## Context

The CLI, planner, policies, and adapters share types and execute primarily on a
developer machine or in CI. Network service boundaries would slow contract changes
and create deployment work before the local product is useful.

## Decision

Use a pnpm TypeScript monorepo with strict package boundaries. Build separate
deployable services only when a hosted control-plane requirement demonstrates the
need.

## Consequences

Iteration and end-to-end testing remain simple. Package dependency rules must be
enforced to prevent the monolith becoming tightly coupled.

