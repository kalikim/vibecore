import { describe, expect, it } from "vitest";
import type { RepositoryScan, VibecoreManifest } from "@vibecore/contracts";
import { createAdoptionPlan, verifyPlanDigest } from "./index.js";

const scan: RepositoryScan = {
  root: "/project",
  fingerprint: "repository-fingerprint",
  applications: [],
  resources: [],
  diagnostics: [],
};
const manifest: VibecoreManifest = {
  apiVersion: "vibecore.dev/v1alpha1",
  kind: "Application",
  metadata: { name: "test" },
  applications: { api: { type: "api", framework: "hono", path: "apps/api" } },
  environments: { local: { runtime: "local-process" } },
};

describe("adoption plans", () => {
  it("produces a stable digest independent of creation time", () => {
    const first = createAdoptionPlan(scan, manifest);
    const second = createAdoptionPlan(scan, manifest);

    expect(first.digest).toBe(second.digest);
    expect(verifyPlanDigest(first)).toBe(true);
  });

  it("detects action tampering", () => {
    const plan = createAdoptionPlan(scan, manifest);
    plan.actions[0]!.summary = "tampered";

    expect(verifyPlanDigest(plan)).toBe(false);
  });
});
