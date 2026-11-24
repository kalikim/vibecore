import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RepositoryScan, VibecoreManifest } from "@codexsafari/vibecore-contracts";
import { createResourcePlan, saveResourcePlan, verifyResourcePlan } from "./resource-plan.js";

const scan: RepositoryScan = { root: "/repo", fingerprint: "input-one", applications: [], resources: [], diagnostics: [] };
const input = { scan, environment: "dev", budgetConscious: true, githubWorkflowPresent: false };

describe("resource-conscious planning", () => {
  it("is deterministic, advisory, and explicit about unknown costs", () => {
    const plan = createResourcePlan(input);
    expect(plan).toEqual(createResourcePlan(input));
    expect(plan.resourcePolicy).toMatchObject({ aiCalls: 0, networkCalls: 0, execution: "disabled", estimatedCloudCost: "unknown" });
    expect(plan.steps[0]?.command).toBe("vibe init --list");
    expect(plan.kind).toBe("advisory");
  });

  it("never copies manifest config values or scan evidence into reports", () => {
    const manifest: VibecoreManifest = {
      apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "sample", description: "private-description" },
      applications: { api: { type: "api", framework: "hono", path: ".", config: { token: "sensitive-value" } } },
      variables: { DATABASE_URL: { required: true, secret: true } }, environments: { dev: { runtime: "local-process" } },
    };
    const plan = createResourcePlan({ ...input, manifest });
    expect(plan.summary.declaredSecretNames).toEqual(["DATABASE_URL"]);
    expect(JSON.stringify(plan)).not.toMatch(/sensitive-value|private-description/);
    expect(plan.steps.some(({ id }) => id === "api-docs")).toBe(true);
  });

  it("rejects tampered and stale reports, including environment or policy changes", () => {
    const plan = createResourcePlan(input);
    expect(() => verifyResourcePlan(plan, plan)).not.toThrow();
    expect(() => verifyResourcePlan({ ...plan, environment: "production" }, plan)).toThrow("integrity");
    for (const current of [
      createResourcePlan({ ...input, scan: { ...scan, fingerprint: "input-two" } }),
      createResourcePlan({ ...input, environment: "production" }),
      createResourcePlan({ ...input, budgetConscious: false }),
      createResourcePlan({ ...input, githubWorkflowPresent: true }),
    ]) expect(() => verifyResourcePlan(plan, current)).toThrow("stale");
  });

  it("flags missing and unprotected production environments", () => {
    const manifest: VibecoreManifest = { apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "sample" }, applications: {}, environments: { dev: { runtime: "local-process" } } };
    const plan = createResourcePlan({ ...input, manifest, environment: "production" });
    expect(plan.findings.filter(({ severity }) => severity === "error").map(({ code }) => code)).toEqual(["environment.missing", "production.unprotected"]);
    expect(() => createResourcePlan({ ...input, environment: "arbitrary" })).toThrow("environment");
  });

  it("saves repeatable reports without overwriting different content", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-resource-plan-"));
    try {
      const plan = createResourcePlan(input);
      const path = await saveResourcePlan(root, plan);
      expect(await saveResourcePlan(root, plan)).toBe(path);
      expect(JSON.parse(await readFile(join(root, path), "utf8"))).toEqual(plan);
      await writeFile(join(root, path), "existing-content");
      await expect(saveResourcePlan(root, plan)).rejects.toThrow("refusing overwrite");
      expect(await readFile(join(root, path), "utf8")).toBe("existing-content");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses symlinked plan storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-resource-plan-link-"));
    try {
      await mkdir(join(root, "outside"));
      await symlink(join(root, "outside"), join(root, ".vibecore"));
      await expect(saveResourcePlan(root, createResourcePlan(input))).rejects.toThrow("real directory");
      expect(await readdir(join(root, "outside"))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
