import { describe, expect, it, vi } from "vitest";
import type { PlanLedgerEntry, Release, VibecoreState } from "@codexsafari/vibecore-contracts";
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
  it("binds approval to the selected release identity and health URL", async () => {
    const recorded = { ...deploying, health: { url: "https://api.example.com/health", status: "unhealthy" as const, checkedAt: "2026-08-21T00:00:00.000Z", attempts: 1, durationMs: 10 } };
    const plan = createReconciliationPlan(state({ releases: [recorded] }));
    const request = vi.fn();
    for (const changed of [
      { ...recorded, sourceRevision: "different" },
      { ...recorded, providerResourceId: "different-target" },
      { ...recorded, health: { ...recorded.health, url: "https://other.example.com/health" } },
    ]) {
      await expect(applyReconciliationWithHealth(state({ releases: [changed] }), plan, plan.digest, { fetch: request })).rejects.toThrow("changed after planning");
      expect(createReconciliationPlan(state({ releases: [changed] })).digest).not.toBe(plan.digest);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("does not probe or change newly added releases outside the approved selection", async () => {
    const plan = createReconciliationPlan(state());
    const unrelated = { ...deploying, id: "new-release", health: { url: "https://unapproved.example.com/health", status: "unhealthy" as const, checkedAt: "2026-08-21T00:00:00.000Z", attempts: 1, durationMs: 10 } };
    const request = vi.fn();
    const next = await applyReconciliationWithHealth(state({ releases: [deploying, unrelated] }), plan, plan.digest, { fetch: request });
    expect(next.releases[1]).toEqual(unrelated);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects missing or duplicate targets before changing state", () => {
    const plan = createReconciliationPlan(state());
    expect(() => applyReconciliationPlan(state({ releases: [] }), plan, plan.digest)).toThrow("missing or duplicated");
    expect(() => applyReconciliationPlan(state({ plans: [executing, executing] }), plan, plan.digest)).toThrow("missing or duplicated");
    expect(() => createReconciliationPlan(state({ releases: [deploying, deploying] }))).toThrow("duplicate target");
  });

  it("rejects changed action state and modified plans", () => {
    const plan = createReconciliationPlan(state());
    const changed = { ...executing, actions: [{ id: "a", status: "failed" as const }] };
    expect(() => applyReconciliationPlan(state({ plans: [changed] }), plan, plan.digest)).toThrow("changed after planning");
    expect(() => applyReconciliationPlan(state(), { ...plan, stateDigest: "tampered" }, plan.digest)).toThrow("modified after generation");
  });

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
