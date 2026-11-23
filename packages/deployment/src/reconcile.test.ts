import { describe, expect, it, vi } from "vitest";
import type { PlanLedgerEntry, Release, VibecoreState } from "@vibecore/contracts";
import { applyReconciliationPlan, applyReconciliationWithHealth, createReconciliationPlan } from "./reconcile.js";

const executing: PlanLedgerEntry = {
  id: "plan-exec", digest: "d1", environment: "dev", createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z", status: "executing", actions: [{ id: "a", status: "executing" }],
};
const deploying: Release = {
  id: "release-deploy", application: "api", provider: "railway", mode: "git", environment: "staging",
  sourceRevision: "abcdef1", planDigest: "digest", status: "deploying",
  createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
};

const state = (overrides: Partial<VibecoreState> = {}): VibecoreState => ({
  apiVersion: "vibecore.dev/state/v1alpha1",
  plans: [executing],
  releases: [deploying],
  ...overrides,
});

describe("interrupted work reconciliation", () => {
  it("plans only executing plans and deploying releases", () => {
    const plan = createReconciliationPlan(state());
    expect(plan).toMatchObject({ action: "reconcile-interrupted", planIds: ["plan-exec"], releaseIds: ["release-deploy"] });
    expect(() => createReconciliationPlan(state({ plans: [{ ...executing, status: "succeeded" }], releases: [{ ...deploying, status: "healthy" }] }))).toThrow("No interrupted");
  });

  it("requires exact approval and marks work interrupted or failed", () => {
    const plan = createReconciliationPlan(state());
    expect(() => applyReconciliationPlan(state(), plan, "wrong")).toThrow("approval");
    const next = applyReconciliationPlan(state(), plan, plan.digest, new Date("2026-08-21T01:00:00.000Z"));
    expect(next.plans[0]?.status).toBe("interrupted");
    expect(next.releases[0]?.status).toBe("failed");
  });

  it("rechecks a deploying release when a health URL is already recorded", async () => {
    const recorded = { ...deploying, health: { url: "https://api.example.com/health", status: "unhealthy" as const, checkedAt: "2026-08-21T00:00:00.000Z", attempts: 1, durationMs: 10 } };
    const current = state({ releases: [recorded] });
    const plan = createReconciliationPlan(current);
    const next = await applyReconciliationWithHealth(current, plan, plan.digest, {
      fetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    });
    expect(next.releases[0]?.status).toBe("healthy");
    expect(JSON.stringify(next)).not.toContain("secret");
  });
});
