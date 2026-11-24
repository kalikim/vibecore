import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Release, VibecoreManifest } from "@codexsafari/vibecore-contracts";
import { createRollbackPlan } from "./releases.js";
import { applyVercelLinkPlan, createVercelDeploymentPlan, createVercelLinkPlan, executeVercelDeploymentPlan, executeVercelRollback, type VercelCommandRunner } from "./vercel.js";

const revision = "abcdef1234567";
const manifest: VibecoreManifest = {
  apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "app" },
  applications: { web: { type: "web", framework: "next", path: "apps/web", commands: { build: "pnpm build" } } },
  variables: { DATABASE_URL: { required: true, secret: true, applications: ["web"] } },
  environments: { dev: { runtime: "local-process" }, staging: { runtime: "github-actions" }, production: { runtime: "github-actions", production: true } },
};

class VercelRunner implements VercelCommandRunner {
  calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  constructor(private readonly inspectId = "dpl_healthy") {}
  async run(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) {
    this.calls.push({ command, args, ...(options?.env ? { env: options.env } : {}) });
    if (command === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: `${revision}\n`, stderr: "" };
    if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "vercel" && args[0] === "deploy") return { exitCode: 0, stdout: "https://app-abc.vercel.app\n", stderr: "" };
    if (command === "vercel" && args[0] === "inspect") return { exitCode: 0, stdout: JSON.stringify({ id: this.inspectId }), stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

const makePlan = (environment = "staging") => createVercelDeploymentPlan(manifest, {
  application: "web", environment, sourceRevision: revision, orgId: "team_123", projectId: "prj_abc", healthUrl: "https://app.example.com/health",
});

describe("Vercel deployment", () => {
  it("creates a token-free plan bound to an existing project", () => {
    const plan = makePlan();
    expect(plan).toMatchObject({ provider: "vercel", mode: "git-web", orgId: "team_123", projectId: "prj_abc", production: false, requiredSecretNames: ["DATABASE_URL", "VERCEL_TOKEN"] });
    expect(JSON.stringify(plan)).not.toContain("--token");
    expect(createVercelDeploymentPlan(manifest, { application: "web", environment: "production", sourceRevision: revision, orgId: "team_123", projectId: "prj_abc", healthUrl: "https://app.example.com/health" }).production).toBe(true);
  });

  it("runs no command before exact and production approval", async () => {
    const plan = makePlan("production");
    const runner = new VercelRunner();
    await expect(executeVercelDeploymentPlan(plan, { approval: "wrong", repositoryRoot: "/repo", token: "token-value", runner })).rejects.toThrow("approval");
    await expect(executeVercelDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", token: "token-value", runner })).rejects.toThrow("production approval");
    expect(runner.calls).toHaveLength(0);
  });

  it("deploys through env identifiers, records the deployment ID, and never puts the token in arguments", async () => {
    const plan = makePlan();
    const runner = new VercelRunner();
    const result = await executeVercelDeploymentPlan(plan, {
      approval: plan.digest, repositoryRoot: "/repo", token: "token-value", runner,
      healthFetch: vi.fn().mockResolvedValue(new Response("ignored", { status: 200 })),
    });
    expect(result.release).toMatchObject({ status: "healthy", providerResourceId: "prj_abc", providerReleaseId: "dpl_healthy" });
    const deploy = runner.calls.find(({ command, args }) => command === "vercel" && args[0] === "deploy");
    expect(deploy?.args).toEqual(["deploy", "--yes", "--cwd", "apps/web"]);
    expect(deploy?.env?.VERCEL_ORG_ID).toBe("team_123");
    expect(deploy?.args.join(" ")).not.toContain("token-value");
    expect(JSON.stringify(result)).not.toContain("token-value");
  });
});

describe("Vercel rollback", () => {
  const release = (overrides: Partial<Release>): Release => ({
    id: "release", application: "web", provider: "vercel", mode: "git-web", environment: "production",
    sourceRevision: revision, planDigest: "digest", status: "healthy", createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z", providerResourceId: "prj_abc", providerReleaseId: "dpl_good", ...overrides,
  });

  it("rolls production back to the preceding deployment ID", async () => {
    const healthy = release({ id: "good" });
    const failed = release({ id: "bad", sourceRevision: "1111111", providerReleaseId: "dpl_bad", status: "unhealthy", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" });
    const plan = createRollbackPlan([failed, healthy], failed.id);
    const runner = new VercelRunner();
    const result = await executeVercelRollback(plan, [failed, healthy], {
      approval: plan.digest, token: "token-value", orgId: "team_123", healthUrl: "https://app.example.com/health",
      productionApproved: true, runner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    });
    expect(result.release).toMatchObject({ status: "healthy", rollbackOf: "bad", providerReleaseId: "dpl_good" });
    expect(runner.calls.some(({ args }) => args[0] === "rollback" && args.includes("dpl_good") && args.includes("--yes"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("token-value");
  });

  it("links an existing Vercel project without overwriting or storing the token", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-vercel-link-"));
    const plan = createVercelLinkPlan(manifest, { application: "web", orgId: "team_123", projectId: "prj_abc" });
    expect(plan.filePath).toBe("apps/web/.vercel/project.json");
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "prj_abc", accountId: "team_123" }), { status: 200 }));
    await expect(applyVercelLinkPlan(plan, { approval: "wrong", repositoryRoot: root, token: "token-value", request })).rejects.toThrow("approval");
    const written = await applyVercelLinkPlan(plan, { approval: plan.digest, repositoryRoot: root, token: "token-value", request });
    expect(written).toBe("apps/web/.vercel/project.json");
    expect(JSON.parse(await readFile(join(root, written), "utf8"))).toEqual({ orgId: "team_123", projectId: "prj_abc" });
    expect(JSON.stringify(plan)).not.toContain("token-value");
    await expect(applyVercelLinkPlan(plan, { approval: plan.digest, repositoryRoot: root, token: "token-value", request })).rejects.toThrow("already exists");
  });

  it("refuses preview rollback instead of inventing a promote", async () => {
    const healthy = release({ id: "good", environment: "staging" });
    const failed = release({ id: "bad", environment: "staging", status: "unhealthy", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" });
    const plan = createRollbackPlan([failed, healthy], failed.id);
    await expect(executeVercelRollback(plan, [failed, healthy], {
      approval: plan.digest, token: "token-value", orgId: "team_123", healthUrl: "https://app.example.com/health", productionApproved: true, runner: new VercelRunner(),
    })).rejects.toThrow("production");
  });
});
