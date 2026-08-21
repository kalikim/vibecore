import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VibecoreManifest } from "@vibecore/contracts";
import { applyDeploymentConfigurationPlan, createVercelPreviewPlan, evaluateDeploymentCompatibility, getDeploymentProvider, listDeploymentProviders } from "./index.js";
const manifest: VibecoreManifest = { apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "app" }, applications: { web: { type: "web", framework: "next", path: "apps/web", commands: { build: "pnpm build" } } }, variables: { DATABASE_URL: { required: true, secret: true, applications: ["web"] } }, environments: { dev: { runtime: "local-process" }, staging: { runtime: "github-actions" }, production: { runtime: "github-actions", production: true } } };
describe("Vercel preview configuration", () => {
  it("binds a secret-free plan to an immutable revision", () => { const plan = createVercelPreviewPlan(manifest, "web", "abcdef1234567"); expect(plan).toMatchObject({ provider: "vercel", environment: "staging", sourceRevision: "abcdef1234567", requiredSecretNames: ["DATABASE_URL"] }); expect(JSON.stringify(plan)).not.toContain("--token"); });
  it("requires approval and refuses overwrites", async () => { const root = await mkdtemp(join(tmpdir(), "vibecore-vercel-")); const plan = createVercelPreviewPlan(manifest, "web", "abcdef1234567"); await expect(applyDeploymentConfigurationPlan(root, plan, "bad")).rejects.toThrow("approval"); await applyDeploymentConfigurationPlan(root, plan, plan.digest); expect(await readFile(join(root, "apps/web/vercel.json"), "utf8")).toContain('"framework": "next"'); await expect(applyDeploymentConfigurationPlan(root, plan, plan.digest)).rejects.toThrow("already exists"); });
});
describe("deployment provider registry", () => {
  it("lists managed cloud and affordable hosting targets without claiming planned deployment is implemented", () => {
    expect(listDeploymentProviders().map(({ id }) => id)).toEqual(["vercel", "railway", "aws", "azure", "digitalocean", "shared-hosting", "self-hosted"]);
    expect(getDeploymentProvider("do")?.id).toBe("digitalocean");
    expect(getDeploymentProvider("shared-hosting")?.modes.find(({ id }) => id === "static-sftp")?.deploy).toBe("planned");
    expect(getDeploymentProvider("self-hosted")?.modes[0]).toMatchObject({ configure: "implemented", deploy: "implemented", rollback: "planned" });
  });
  it("matches applications to provider modes and keeps mobile releases separate", () => {
    expect(evaluateDeploymentCompatibility(manifest, "web", "azure", "app-service")).toMatchObject({ workload: "node", compatible: true, status: "planned" });
    expect(evaluateDeploymentCompatibility(manifest, "web", "shared-hosting", "static-sftp")).toMatchObject({ compatible: false, status: "unsupported" });
    const mobile: VibecoreManifest = { ...manifest, applications: { app: { type: "mobile", framework: "expo", language: "typescript", path: "apps/mobile" } } };
    expect(evaluateDeploymentCompatibility(mobile, "app", "railway", "git")).toMatchObject({ compatible: false, status: "unsupported" });
  });
});
