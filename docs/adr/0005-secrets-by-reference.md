# ADR 0005: Store secrets by reference only

Status: Accepted

## Context

Plans, logs, state, CI files, and AI conversations are common secret-leak paths.

## Decision

Manifests declare secret contracts and sources but never values. Values are resolved
at execution time, scoped to the required action, and filtered from logs. State may
store names and provider version identifiers only.

## Consequences

Secret rotation and provider access require adapters. Some validation can confirm
presence and format but cannot compare or display values.

