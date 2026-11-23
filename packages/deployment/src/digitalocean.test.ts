import { describe, expect, it, vi } from "vitest";
import type { Release, VibecoreManifest } from "@vibecore/contracts";
import { createRollbackPlan } from "./releases.js";
import { createDigitalOceanDeploymentPlan, createDigitalOceanImagePlan, executeDigitalOceanDeploymentPlan, executeDigitalOceanImagePlan, executeDigitalOceanRollback, type DigitalOceanCommandRunner } from "./digitalocean.js";

const revision = "abcdef1234567890abcdef1234567890abcdef12";
const manifest: VibecoreManifest = { apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "app" }, applications: { api: { type: "api", framework: "hono", language: "typescript", path: "apps/api" } }, variables: { DATABASE_URL: { required: true, secret: true, applications: ["api"] } }, environments: { dev: { runtime: "local-process" }, staging: { runtime: "digitalocean" }, production: { runtime: "digitalocean", production: true } } };

class DigitalOceanRunner implements DigitalOceanCommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly deployOnPush = false, private readonly remoteRevision = revision) {}
  async run(command: string, args: string[]) { this.calls.push({ command, args }); if (command === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: `${revision}\n`, stderr: "" }; if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" }; if (command === "git" && args[0] === "ls-remote") return { exitCode: 0, stdout: `${this.remoteRevision}\trefs/heads/main\n`, stderr: "" }; if (command === "doctl" && args.includes("get")) return { exitCode: 0, stdout: JSON.stringify({ app: { spec: { services: [{ github: { repo: "owner/repo", branch: "main", deploy_on_push: this.deployOnPush } }] } } }), stderr: "" }; return { exitCode: 0, stdout: "deployment-123\n", stderr: "" }; }
}

const makePlan = (environment = "staging") => createDigitalOceanDeploymentPlan(manifest, { application: "api", environment, sourceRevision: revision, appId: "app-123", repository: "owner/repo", branch: "main", healthUrl: "https://api.example.com/health" });

describe("DigitalOcean App Platform deployment", () => {
  it("creates a token-free plan bound to a full source revision", () => { const plan = makePlan(); expect(plan).toMatchObject({ provider: "digitalocean", mode: "app-platform", appId: "app-123", repository: "owner/repo", requiredSecretNames: ["DATABASE_URL", "DIGITALOCEAN_ACCESS_TOKEN"] }); expect(() => createDigitalOceanDeploymentPlan(manifest, { application: "api", environment: "staging", sourceRevision: "abcdef1", appId: "app-123", repository: "owner/repo", branch: "main", healthUrl: "https://api.example.com" })).toThrow("full Git"); });
  it("runs no command before exact and production approval", async () => { const plan = makePlan("production"); const runner = new DigitalOceanRunner(); await expect(executeDigitalOceanDeploymentPlan(plan, { approval: "wrong", repositoryRoot: "/repo", token: "token-value", runner })).rejects.toThrow("approval"); await expect(executeDigitalOceanDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", token: "token-value", runner })).rejects.toThrow("production approval"); expect(runner.calls).toHaveLength(0); });
  it("rejects branch drift and automatic deployment races", async () => { const plan = makePlan(); await expect(executeDigitalOceanDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", token: "token-value", runner: new DigitalOceanRunner(false, "1".repeat(40)) })).rejects.toThrow("branch"); await expect(executeDigitalOceanDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", token: "token-value", runner: new DigitalOceanRunner(true) })).rejects.toThrow("deploy-on-push"); });
  it("waits for deployment, captures provider IDs, and does not expose the token", async () => { const plan = makePlan(); const runner = new DigitalOceanRunner(); const result = await executeDigitalOceanDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", token: "token-value", runner, healthFetch: vi.fn().mockResolvedValue(new Response("ignored", { status: 200 })) }); expect(result.release).toMatchObject({ status: "healthy", providerResourceId: "app-123", providerReleaseId: "deployment-123" }); const command = runner.calls.find(({ command, args }) => command === "doctl" && args.includes("create-deployment")); expect(command?.args).toContain("--wait"); expect(JSON.stringify(result)).not.toContain("token-value"); expect(runner.calls.flatMap(({ args }) => args)).not.toContain("token-value"); });
});

describe("DigitalOcean App Platform image deployment", () => {
  const image = `ghcr.io/example/api@sha256:${"a".repeat(64)}`;
  const imageManifest: VibecoreManifest = {
    ...manifest,
    applications: { api: { ...manifest.applications.api!, config: { deploymentWorkload: "container", deploymentImage: image } } },
  };
  class ImageRunner implements DigitalOceanCommandRunner {
    calls: Array<{ command: string; args: string[] }> = [];
    constructor(private readonly spec: unknown = { app: { spec: { services: [{ image: { registry: "ghcr.io", repository: "example/api", digest: "sha256:old" } }] } } }) {}
    async run(command: string, args: string[]) {
      this.calls.push({ command, args });
      if (command === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: `${revision}\n`, stderr: "" };
      if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      if (command === "doctl" && args.includes("get")) return { exitCode: 0, stdout: JSON.stringify(this.spec), stderr: "" };
      return { exitCode: 0, stdout: "deployment-image-1\n", stderr: "" };
    }
  }
  it("pins an existing image app without putting the token in arguments", async () => {
    const plan = createDigitalOceanImagePlan(imageManifest, { application: "api", environment: "staging", sourceRevision: revision, appId: "app-123", healthUrl: "https://api.example.com/health" });
    expect(plan).toMatchObject({ mode: "app-platform-image", image });
    const runner = new ImageRunner();
    const result = await executeDigitalOceanImagePlan(plan, { approval: plan.digest, repositoryRoot: "/repo", token: "token-value", runner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    expect(result.release).toMatchObject({ status: "healthy", providerReleaseId: "deployment-image-1" });
    expect(runner.calls.some(({ args }) => args.includes("update") && args.includes("--spec"))).toBe(true);
    expect(runner.calls.flatMap(({ args }) => args)).not.toContain("token-value");
    expect(JSON.stringify(result)).not.toContain("token-value");
  });
  it("refuses GitHub auto-deploy image apps before updating the spec", async () => {
    const plan = createDigitalOceanImagePlan(imageManifest, { application: "api", environment: "staging", sourceRevision: revision, appId: "app-123", healthUrl: "https://api.example.com/health" });
    const runner = new ImageRunner({ app: { spec: { services: [{ image: { repository: "example/api" }, github: { repo: "owner/repo", branch: "main", deploy_on_push: true } }] } } });
    await expect(executeDigitalOceanImagePlan(plan, { approval: plan.digest, repositoryRoot: "/repo", token: "token-value", runner })).rejects.toThrow("deploy-on-push");
    expect(runner.calls.some(({ args }) => args.includes("update"))).toBe(false);
  });
});

describe("DigitalOcean rollback", () => {
  const release = (overrides: Partial<Release>): Release => ({ id: "release", application: "api", provider: "digitalocean", mode: "app-platform", environment: "staging", sourceRevision: revision, planDigest: "digest", status: "healthy", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", providerResourceId: "app-123", providerReleaseId: "deployment-good", ...overrides });
  it("validates then performs a historical rollback and health check", async () => { const healthy = release({ id: "good" }); const failed = release({ id: "bad", sourceRevision: "1".repeat(40), providerReleaseId: "deployment-bad", status: "unhealthy", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" }); const plan = createRollbackPlan([failed, healthy], failed.id); const apiFetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ valid: true }), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ deployment: { id: "deployment-rollback" } }), { status: 200 })); const result = await executeDigitalOceanRollback(plan, [failed, healthy], { approval: plan.digest, token: "token-value", healthUrl: "https://api.example.com/health", apiFetch, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) }); expect(result.failed.status).toBe("rolled-back"); expect(result.release).toMatchObject({ status: "healthy", rollbackOf: "bad", providerReleaseId: "deployment-rollback" }); expect(apiFetch.mock.calls[0]?.[0]).toContain("/apps/app-123/rollback/validate"); expect(JSON.stringify(result)).not.toContain("token-value"); });
});
