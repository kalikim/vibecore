import { describe, expect, it, vi } from "vitest";
import type { VibecoreManifest } from "@codexsafari/vibecore-contracts";
import { createRollbackPlan } from "./releases.js";
import { createDigitalOceanDropletPlan, executeDigitalOceanDropletPlan, executeDigitalOceanDropletRollback } from "./droplet.js";
import type { DeploymentCommandRunner } from "./self-hosted.js";

const digest = "a".repeat(64);
const image = `ghcr.io/example/api@sha256:${digest}`;
const manifest: VibecoreManifest = {
  apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "safe-app" },
  applications: { api: { type: "api", framework: "hono", language: "typescript", path: "apps/api", health: { path: "/health" }, config: { deploymentWorkload: "container", deploymentImage: image, port: 3000, hostPort: 8080 } } },
  variables: { DATABASE_URL: { required: true, secret: true, applications: ["api"] } },
  environments: { dev: { runtime: "local-process" }, staging: { runtime: "digitalocean" }, production: { runtime: "digitalocean", production: true } },
};

class DropletRunner implements DeploymentCommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly droplet: Record<string, unknown> = {
    id: 314159, name: "api-staging", status: "active",
    networks: { v4: [{ ip_address: "203.0.113.10", type: "public" }] },
  }) {}
  async run(command: string, args: string[]) {
    this.calls.push({ command, args });
    if (command === "doctl" && args.includes("droplet") && args.includes("get")) {
      return { exitCode: 0, stdout: JSON.stringify(this.droplet), stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

const makePlan = (environment = "staging") => createDigitalOceanDropletPlan(manifest, {
  application: "api", environment, sourceRevision: "abcdef1234567", dropletId: "314159",
  host: "203.0.113.10", user: "vibecore", healthUrl: "https://api.example.com/health",
});

describe("DigitalOcean Droplet deployment", () => {
  it("plans a digest-pinned Compose release without the API token", () => {
    const plan = makePlan();
    expect(plan).toMatchObject({ provider: "digitalocean", mode: "droplet", dropletId: "314159", image, requiredSecretNames: ["DATABASE_URL", "DIGITALOCEAN_ACCESS_TOKEN"] });
    expect(plan.compose).toContain("read_only: true");
    expect(JSON.stringify(plan)).not.toContain("dop_");
    expect(() => createDigitalOceanDropletPlan(manifest, { application: "api", environment: "staging", sourceRevision: "abcdef1234567", dropletId: "314159", host: "203.0.113.10", user: "root", healthUrl: "https://api.example.com/health" })).toThrow("root");
    const mutable = structuredClone(manifest);
    mutable.applications.api!.config!.deploymentImage = "ghcr.io/example/api:latest";
    expect(() => createDigitalOceanDropletPlan(mutable, { application: "api", environment: "staging", sourceRevision: "abcdef1234567", dropletId: "314159", host: "203.0.113.10", user: "vibecore", healthUrl: "https://api.example.com/health" })).toThrow("pinned");
  });

  it("runs no command before exact and production approval", async () => {
    const production = makePlan("production");
    const runner = new DropletRunner();
    await expect(executeDigitalOceanDropletPlan(production, { approval: "wrong", token: "token-value", sshKeyPath: "/keys/deploy", runner })).rejects.toThrow("approval");
    await expect(executeDigitalOceanDropletPlan(production, { approval: production.digest, token: "token-value", sshKeyPath: "/keys/deploy", runner })).rejects.toThrow("production approval");
    expect(runner.calls).toHaveLength(0);
  });

  it("confirms the existing droplet before SSH and never puts the token in arguments", async () => {
    const plan = makePlan();
    const runner = new DropletRunner();
    const result = await executeDigitalOceanDropletPlan(plan, {
      approval: plan.digest, token: "token-value", sshKeyPath: "/keys/deploy", runner,
      healthFetch: vi.fn().mockResolvedValue(new Response("secret body is ignored", { status: 200 })),
    });
    expect(result.release).toMatchObject({ status: "healthy", providerResourceId: "314159", providerReleaseId: image });
    expect(runner.calls.some(({ command, args }) => command === "doctl" && args.includes("compute") && args.includes("droplet") && args.includes("get"))).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("create"))).toBe(false);
    expect(runner.calls.some(({ args }) => args.includes("StrictHostKeyChecking=yes"))).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("/opt/vibecore/safe-app/releases/abcdef1234567/compose.yaml"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("token-value");
    expect(runner.calls.flatMap(({ args }) => args)).not.toContain("token-value");
  });

  it("rejects inactive droplets and host mismatches before opening SSH", async () => {
    const plan = makePlan();
    const inactive = new DropletRunner({ id: 314159, name: "api-staging", status: "off", networks: { v4: [{ ip_address: "203.0.113.10", type: "public" }] } });
    await expect(executeDigitalOceanDropletPlan(plan, { approval: plan.digest, token: "token-value", sshKeyPath: "/keys/deploy", runner: inactive })).rejects.toThrow("active");
    expect(inactive.calls.some(({ command }) => command === "ssh")).toBe(false);
    const mismatch = new DropletRunner({ id: 314159, name: "other", status: "active", networks: { v4: [{ ip_address: "198.51.100.10", type: "public" }] } });
    await expect(executeDigitalOceanDropletPlan(plan, { approval: plan.digest, token: "token-value", sshKeyPath: "/keys/deploy", runner: mismatch })).rejects.toThrow("host");
    expect(mismatch.calls.some(({ command }) => command === "ssh")).toBe(false);
  });

  it("rolls back by restarting the preceding versioned Compose release", async () => {
    const healthy = { id: "release-good", application: "api", provider: "digitalocean", mode: "droplet", environment: "staging", sourceRevision: "1111111", planDigest: "one", status: "healthy" as const, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z", providerResourceId: "314159", providerReleaseId: `ghcr.io/example/api@sha256:${"b".repeat(64)}` };
    const failed = { ...healthy, id: "release-bad", sourceRevision: "2222222", planDigest: "two", status: "unhealthy" as const, createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z", providerReleaseId: image };
    const rollback = createRollbackPlan([failed, healthy], failed.id);
    const runner = new DropletRunner();
    const result = await executeDigitalOceanDropletRollback(rollback, [failed, healthy], {
      approval: rollback.digest, token: "token-value", host: "203.0.113.10", user: "vibecore",
      remoteRoot: "/opt/vibecore/safe-app", healthUrl: "https://api.example.com/health", sshKeyPath: "/keys/deploy", runner,
      healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    });
    expect(result.failed.status).toBe("rolled-back");
    expect(result.release).toMatchObject({ sourceRevision: "1111111", status: "healthy", rollbackOf: "release-bad", providerResourceId: "314159" });
    expect(runner.calls.some(({ args }) => args.includes("/opt/vibecore/safe-app/releases/1111111/compose.yaml"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("token-value");
  });
});
