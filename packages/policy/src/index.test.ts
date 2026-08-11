import { describe, expect, it } from "vitest";
import type { Action, Plan } from "@vibecore/contracts";
import { evaluatePlan } from "./index.js";

function plan(action: Action, environment = "local"): Plan {
  return {
    apiVersion: "vibecore.dev/plan/v1alpha1",
    id: "plan-test",
    digest: "approved-digest",
    createdAt: "2026-08-11T00:00:00.000Z",
    repositoryFingerprint: "repository",
    environment,
    actions: [action],
  };
}

const baseAction: Action = {
  id: "test",
  adapter: "test",
  operation: "test",
  summary: "Test action",
  risk: "write",
  dependsOn: [],
  inputs: {},
  permissions: [],
};

describe("evaluatePlan", () => {
  it("allows read actions without approval", () => {
    const result = evaluatePlan(plan({ ...baseAction, risk: "read" }));
    expect(result.allowed).toBe(true);
  });

  it("requires the exact digest for write actions", () => {
    expect(evaluatePlan(plan(baseAction)).allowed).toBe(false);
    expect(evaluatePlan(plan(baseAction), { approval: "wrong" }).allowed).toBe(false);
    expect(evaluatePlan(plan(baseAction), { approval: "approved-digest" }).allowed).toBe(true);
  });

  it("requires separate production approval and backup evidence", () => {
    const destructive = { ...baseAction, risk: "destructive" as const };
    const denied = evaluatePlan(plan(destructive, "production"), {
      approval: "approved-digest",
      productionApproved: true,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.decisions.some(({ code }) => code === "policy.production.backup-required")).toBe(true);

    const allowed = evaluatePlan(plan({ ...destructive, inputs: { backupVerified: true } }, "production"), {
      approval: "approved-digest",
      productionApproved: true,
    });
    expect(allowed.allowed).toBe(true);
  });
});
