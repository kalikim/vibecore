# ADR 0004: Use capability adapters with explicit limitations

Status: Accepted

## Context

Cloud and framework providers differ in meaningful ways. Pretending they are fully
equivalent creates leaky abstractions and surprising deployment behavior.

## Decision

Core models capabilities and dependencies. Adapters declare supported operations,
permissions, and limitations. Provider escape hatches remain available.

## Consequences

The core stays provider-neutral, while some workflows correctly vary by provider.
Adapter conformance tests are required before ecosystem expansion.

