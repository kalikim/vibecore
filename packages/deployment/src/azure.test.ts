import { describe, expect, it, vi } from "vitest";
import type { Release, VibecoreManifest } from "@codexsafari/vibecore-contracts";
import { createRollbackPlan } from "./releases.js";
import { createAzureDeploymentPlan, executeAzureDeploymentPlan, executeAzureRollback, type AzureCommandRunner, type AzureDeploymentMode } from "./azure.js";

const revision = "abcdef1234567890abcdef1234567890abcdef12";
const previous = "1111111111111111111111111111111111111111";
const subscriptionId = "11111111-1111-1111-1111-111111111111";
const tenantId = "22222222-2222-2222-2222-222222222222";
const image = "example.azurecr.io/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const manifest: VibecoreManifest = {
  apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "app" },
  applications: {
    api: { type: "api", framework: "hono", language: "typescript", path: "apps/api", commands: { start: "node dist/index.js" }, health: { path: "/health" } },
    web: { type: "web", framework: "vite-react", language: "typescript", path: "apps/web", config: { outputDirectory: "dist" } },
    worker: { type: "api", framework: "hono", language: "typescript", path: "apps/api", config: { deploymentWorkload: "container", deploymentImage: image } },
  },
  variables: { DATABASE_URL: { required: true, secret: true, applications: ["api", "worker"] } },
  environments: { dev: { runtime: "local-process" }, staging: { runtime: "azure" }, production: { runtime: "azure", production: true } },
};

const armId = (mode: AzureDeploymentMode) => {
  const provider = mode === "container-apps" ? "Microsoft.App/containerApps" : mode === "static-web-apps" ? "Microsoft.Web/staticSites" : "Microsoft.Web/sites";
  const name = mode === "static-web-apps" ? "web-staging" : "api-staging";
  return `/subscriptions/${subscriptionId}/resourceGroups/rg-app/providers/${provider}/${name}`;
};

class AzureRunner implements AzureCommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly options: { dirty?: string; subscription?: string; tenant?: string; repositoryUrl?: string; revisionsMode?: string; httpsOnly?: boolean; buildDuringDeploy?: boolean; latestRevision?: string } = {}) {}
  async run(command: string, args: string[]) {
    this.calls.push({ command, args });
    if (command === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: `${revision}\n`, stderr: "" };
    if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: this.options.dirty ?? "", stderr: "" };
    if (command === "git" && args[0] === "archive") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "test") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "swa") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "az" && args[0] === "account") return { exitCode: 0, stdout: JSON.stringify({ id: this.options.subscription ?? subscriptionId, tenantId: this.options.tenant ?? tenantId, state: "Enabled" }), stderr: "" };
    if (command === "az" && args[1] === "show") {
      const mode = args[0] === "containerapp" ? "container-apps" : args[0] === "staticwebapp" ? "static-web-apps" : "app-service";
      return { exitCode: 0, stdout: JSON.stringify({
        id: armId(mode),
        kind: "app,linux",
        httpsOnly: this.options.httpsOnly ?? true,
        siteConfig: { linuxFxVersion: "NODE|22-lts", ftpsState: "Disabled" },
        properties: { repositoryUrl: this.options.repositoryUrl ?? "", configuration: { activeRevisionsMode: this.options.revisionsMode ?? "Multiple" }, siteConfig: { linuxFxVersion: "NODE|22-lts", ftpsState: "Disabled" } },
      }), stderr: "" };
    }
    if (command === "az" && args.includes("appsettings")) return { exitCode: 0, stdout: JSON.stringify(this.options.buildDuringDeploy === false ? [] : [{ name: "SCM_DO_BUILD_DURING_DEPLOYMENT", value: "true" }]), stderr: "" };
    if (command === "az" && args[1] === "update") return { exitCode: 0, stdout: JSON.stringify({ properties: { latestRevisionName: this.options.latestRevision ?? "api-staging--rev-abcdef1234" } }), stderr: "" };
    return { exitCode: 0, stdout: "{}", stderr: "" };
  }
}

const makePlan = (mode: AzureDeploymentMode, environment = "staging", application = mode === "static-web-apps" ? "web" : mode === "container-apps" ? "worker" : "api") => createAzureDeploymentPlan(manifest, {
  application, environment, sourceRevision: revision, mode, subscriptionId, tenantId, resourceGroup: "rg-app",
  resourceName: mode === "static-web-apps" ? "web-staging" : "api-staging", healthUrl: "https://api.example.com/health",
});

describe("Azure deployment plans", () => {
  it("creates a secret-free plan bound to a full revision and Azure identifiers", () => {
    const plan = makePlan("app-service");
    expect(plan).toMatchObject({ provider: "azure", mode: "app-service", subscriptionId, tenantId, resourceGroup: "rg-app", requiredSecretNames: ["DATABASE_URL"] });
    expect(JSON.stringify(plan)).not.toContain("client-secret");
    expect(() => createAzureDeploymentPlan(manifest, { application: "api", environment: "staging", sourceRevision: "abcdef1", mode: "app-service", subscriptionId, tenantId, resourceGroup: "rg-app", resourceName: "api-staging", healthUrl: "https://api.example.com/health" })).toThrow("full Git");
    expect(() => makePlan("container-apps")).not.toThrow();
  });

  it("requires digest-pinned images for container modes", () => {
    expect(() => createAzureDeploymentPlan(manifest, { application: "api", environment: "staging", sourceRevision: revision, mode: "container-apps", subscriptionId, tenantId, resourceGroup: "rg-app", resourceName: "api-staging", healthUrl: "https://api.example.com/health" })).toThrow("deploymentWorkload: container");
    expect(makePlan("container-apps").image).toBe(image);
    expect(makePlan("static-web-apps").outputDirectory).toBe("dist");
  });
});

describe("Azure execution", () => {
  it("runs no command before exact and production approval", async () => {
    const plan = makePlan("app-service", "production");
    const runner = new AzureRunner();
    await expect(executeAzureDeploymentPlan(plan, { approval: "wrong", repositoryRoot: "/repo", runner })).rejects.toThrow("approval");
    await expect(executeAzureDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", runner })).rejects.toThrow("production approval");
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses identity drift, dirty trees, connected SWA repos, and single-revision Container Apps", async () => {
    const app = makePlan("app-service");
    await expect(executeAzureDeploymentPlan(app, { approval: app.digest, repositoryRoot: "/repo", runner: new AzureRunner({ subscription: "33333333-3333-3333-3333-333333333333" }) })).rejects.toThrow("subscription");
    await expect(executeAzureDeploymentPlan(app, { approval: app.digest, repositoryRoot: "/repo", runner: new AzureRunner({ dirty: " M apps/api/index.ts" }) })).rejects.toThrow("changed");
    await expect(executeAzureDeploymentPlan(app, { approval: app.digest, repositoryRoot: "/repo", runner: new AzureRunner({ buildDuringDeploy: false }) })).rejects.toThrow("SCM_DO_BUILD_DURING_DEPLOYMENT");
    const swa = makePlan("static-web-apps");
    await expect(executeAzureDeploymentPlan(swa, { approval: swa.digest, repositoryRoot: "/repo", runner: new AzureRunner({ repositoryUrl: "https://github.com/owner/repo" }) })).rejects.toThrow("Disconnect");
    const container = makePlan("container-apps");
    await expect(executeAzureDeploymentPlan(container, { approval: container.digest, repositoryRoot: "/repo", runner: new AzureRunner({ revisionsMode: "Single" }) })).rejects.toThrow("multiple revision");
  });

  it("zip-deploys App Service from git archive without client secrets", async () => {
    const plan = makePlan("app-service");
    const runner = new AzureRunner();
    const result = await executeAzureDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", runner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    const deploy = runner.calls.find(({ command, args }) => command === "az" && args[1] === "deploy");
    expect(deploy?.args).toContain("--src-path");
    expect(deploy?.args).toEqual(expect.arrayContaining(["--type", "zip", "--async", "false", "--track-status"]));
    expect(runner.calls.some(({ command, args }) => command === "git" && args[0] === "archive")).toBe(true);
    expect(runner.calls.some(({ command, args }) => command === "az" && args[0] === "login")).toBe(false);
    expect(runner.calls.flatMap(({ args }) => args).join(" ")).not.toMatch(/password|client-secret|deployment-token/i);
    expect(result.release).toMatchObject({ provider: "azure", status: "healthy", providerResourceId: armId("app-service"), providerReleaseId: revision });
    expect(JSON.stringify(result)).not.toContain("client-secret");
  });

  it("updates Container Apps with a digest-pinned image and shifts traffic", async () => {
    const plan = makePlan("container-apps");
    const runner = new AzureRunner();
    const result = await executeAzureDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", runner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    const update = runner.calls.find(({ command, args }) => command === "az" && args[0] === "containerapp" && args[1] === "update");
    expect(update?.args).toEqual(expect.arrayContaining(["--image", image, "--revision-suffix", "rev-abcdef1234"]));
    expect(runner.calls.some(({ args }) => args.includes("--revision-weight") && args.includes("api-staging--rev-abcdef1234=100"))).toBe(true);
    expect(result.release).toMatchObject({ status: "healthy", providerReleaseId: "api-staging--rev-abcdef1234" });
  });

  it("deploys Static Web Apps through swa using the Azure CLI identity", async () => {
    const plan = makePlan("static-web-apps");
    const runner = new AzureRunner();
    const result = await executeAzureDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", runner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    const swa = runner.calls.find(({ command }) => command === "swa");
    expect(swa?.args).toEqual(["deploy", "apps/web/dist", "--subscription-id", subscriptionId, "--resource-group", "rg-app", "--app-name", "web-staging", "--env", "staging"]);
    expect(swa?.args.join(" ")).not.toContain("deployment-token");
    expect(result.release).toMatchObject({ status: "healthy", providerReleaseId: revision });
  });
});

describe("Azure rollback", () => {
  const healthy = (overrides: Partial<Release> = {}): Release => ({
    id: "good", application: "api", provider: "azure", mode: "container-apps", environment: "staging", sourceRevision: previous, planDigest: "digest", status: "healthy",
    createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", providerResourceId: armId("container-apps"), providerReleaseId: "api-staging--rev-1111111111", ...overrides,
  });

  it("shifts Container Apps traffic to the preceding healthy revision", async () => {
    const failed = healthy({ id: "bad", sourceRevision: revision, status: "unhealthy", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z", providerReleaseId: "api-staging--rev-abcdef1234" });
    const good = healthy();
    const plan = createRollbackPlan([failed, good], failed.id);
    const runner = new AzureRunner();
    const result = await executeAzureRollback(plan, [failed, good], { approval: plan.digest, repositoryRoot: "/repo", applicationPath: "apps/api", tenantId, healthUrl: "https://api.example.com/health", runner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    expect(result.failed.status).toBe("rolled-back");
    expect(result.release).toMatchObject({ status: "healthy", rollbackOf: "bad", providerReleaseId: "api-staging--rev-1111111111" });
    expect(runner.calls.some(({ args }) => args.includes("--revision-weight") && args.includes("api-staging--rev-1111111111=100"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("client-secret");
  });

  it("redeploys the preceding App Service zip and refuses Static Web Apps historical rollback", async () => {
    const good = healthy({ mode: "app-service", providerResourceId: armId("app-service"), providerReleaseId: previous });
    const failed = healthy({ id: "bad", mode: "app-service", sourceRevision: revision, status: "unhealthy", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z", providerResourceId: armId("app-service"), providerReleaseId: revision });
    const plan = createRollbackPlan([failed, good], failed.id);
    const runner = new AzureRunner();
    const result = await executeAzureRollback(plan, [failed, good], { approval: plan.digest, repositoryRoot: "/repo", applicationPath: "apps/api", tenantId, healthUrl: "https://api.example.com/health", runner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    expect(runner.calls.some(({ command, args }) => command === "git" && args[0] === "archive" && args.includes(`${previous}:apps/api`))).toBe(true);
    expect(result.release.providerReleaseId).toBe(previous);
    const swaFailed = healthy({ id: "swa-bad", application: "web", mode: "static-web-apps", status: "unhealthy", createdAt: "2026-08-21T00:00:00.000Z", providerResourceId: armId("static-web-apps") });
    const swaGood = healthy({ application: "web", mode: "static-web-apps", providerResourceId: armId("static-web-apps") });
    const swaPlan = createRollbackPlan([swaFailed, swaGood], swaFailed.id);
    await expect(executeAzureRollback(swaPlan, [swaFailed, swaGood], { approval: swaPlan.digest, repositoryRoot: "/repo", applicationPath: "apps/web", tenantId, healthUrl: "https://web.example.com", runner: new AzureRunner() })).rejects.toThrow("unsupported");
  });
});
