# ADR 0003: Separate planning, policy, and execution

Status: Accepted

## Context

Repository, infrastructure, and database automation can produce destructive or
expensive effects. AI-assisted workflows particularly need inspectable boundaries.

## Decision

Discovery and planning are read-only. Policies evaluate immutable proposed actions.
Only an approved, non-stale plan can reach the executor.

## Consequences

Commands may take an additional step, but become auditable, testable, and suitable
for both interactive and CI use.

