import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RepositoryScan, VibecoreManifest } from "@vibecore/contracts";
import { createAdoptionPlan } from "@vibecore/planner";
import { applyAdoptionPlan } from "./index.js";

const manifest: VibecoreManifest = {
  apiVersion: "vibecore.dev/v1alpha1",
  kind: "Application",
  metadata: { name: "test" },
  applications: { api: { type: "api", framework: "hono", path: "apps/api" } },
  environments: { local: { runtime: "local-process" } },
};

describe("applyAdoptionPlan", () => {
  it("writes a new manifest after exact digest approval", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "vibecore-executor-"));
    const scan: RepositoryScan = { root: repositoryRoot, fingerprint: "one", applications: [], resources: [], diagnostics: [] };
    const plan = createAdoptionPlan(scan, manifest);

    const result = await applyAdoptionPlan(plan, {
      repositoryRoot,
      approval: plan.digest,
      currentRepositoryFingerprint: "one",
    });

    expect(result.status).toBe("succeeded");
    expect(await readFile(join(repositoryRoot, "vibecore.yaml"), "utf8")).toContain("name: test");
  });

  it("refuses stale plans and existing manifests", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "vibecore-executor-"));
    const scan: RepositoryScan = { root: repositoryRoot, fingerprint: "one", applications: [], resources: [], diagnostics: [] };
    const plan = createAdoptionPlan(scan, manifest);

    await expect(applyAdoptionPlan(plan, {
      repositoryRoot,
      approval: plan.digest,
      currentRepositoryFingerprint: "changed",
    })).rejects.toThrow("Repository inputs changed");

    await writeFile(join(repositoryRoot, "vibecore.yaml"), "existing");
    await expect(applyAdoptionPlan(plan, {
      repositoryRoot,
      approval: plan.digest,
      currentRepositoryFingerprint: "one",
    })).rejects.toThrow();
    expect(await readFile(join(repositoryRoot, "vibecore.yaml"), "utf8")).toBe("existing");
  });
});
