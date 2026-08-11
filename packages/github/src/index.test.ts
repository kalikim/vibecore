import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VibecoreManifest } from "@vibecore/contracts";
import { applyGitHubSetupPlan, createGitHubSetupPlan } from "./index.js";

const manifest: VibecoreManifest = { apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "app" }, applications: { api: { type: "api", framework: "hono", path: "." } }, variables: { DATABASE_URL: { required: true, secret: true } }, environments: { dev: { runtime: "local-process" }, staging: { runtime: "github-actions" }, production: { runtime: "github-actions", production: true } } };
describe("GitHub setup", () => {
  it("generates least-privilege workflows and environment-scoped secret references only", () => { const plan = createGitHubSetupPlan(manifest); const source = JSON.stringify(plan); expect(source).toContain("contents"); expect(source).toContain("persist-credentials"); expect(source).toContain("secrets.DATABASE_URL"); expect(source).not.toContain("postgresql://"); expect(plan.files).toHaveLength(3); });
  it("requires exact approval and refuses overwrites", async () => { const root = await mkdtemp(join(tmpdir(), "vibecore-github-")); const plan = createGitHubSetupPlan(manifest); await expect(applyGitHubSetupPlan(root, plan, "wrong")).rejects.toThrow("approval"); await applyGitHubSetupPlan(root, plan, plan.digest); expect(await readFile(join(root, ".github/workflows/ci.yml"), "utf8")).toContain("permissions:"); await expect(applyGitHubSetupPlan(root, plan, plan.digest)).rejects.toThrow("already exists"); });
});
