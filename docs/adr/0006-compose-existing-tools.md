# ADR 0006: Compose existing tools instead of replacing them

Status: Accepted

## Context

Frameworks, Prisma, Docker, GitHub Actions, Vercel, and EAS already solve specialized
problems. Reimplementing them would expand scope and create lock-in.

## Decision

Vibecore orchestrates upstream tools through adapters and leaves ordinary provider
configuration in the repository when it is useful outside Vibecore.

## Consequences

Users retain escape hatches and can remove Vibecore. Compatibility testing and
clear version support policies become important ongoing work.

