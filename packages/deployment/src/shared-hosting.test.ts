import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { VibecoreManifest } from "@codexsafari/vibecore-contracts";
import { createRollbackPlan } from "./releases.js";
import { createSharedHostingPlan, executeSharedHostingPlan, executeSharedHostingRollback, type SharedHostingMode } from "./shared-hosting.js";
import type { DeploymentCommandRunner } from "./self-hosted.js";

const manifest: VibecoreManifest = {
  apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "cheap-site" },
  applications: {
    web: { type: "web", framework: "vite-react", language: "typescript", path: "apps/web", commands: { build: "pnpm build" }, config: { outputDirectory: "dist" } },
    php: { type: "web", framework: "laravel", language: "php", path: "apps/php", commands: { build: "composer install --no-dev" } },
  },
  variables: { DATABASE_URL: { required: true, secret: true, applications: ["php"] } },
  environments: { dev: { runtime: "local-process" }, staging: { runtime: "shared-hosting" }, production: { runtime: "shared-hosting", production: true } },
};

class ScriptedRunner implements DeploymentCommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly failWhen: (command: string, args: string[]) => boolean = () => false) {}
  async run(command: string, args: string[]) {
    this.calls.push({ command, args });
    if (this.failWhen(command, args)) return { exitCode: 1, stdout: "", stderr: "denied" };
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vibecore-sftp-"));
  await mkdir(join(root, "apps/web/dist"), { recursive: true });
  await mkdir(join(root, "apps/php"), { recursive: true });
  await writeFile(join(root, "apps/web/dist/index.html"), "<html></html>");
  await writeFile(join(root, "apps/php/index.php"), "<?php echo 'ok';");
  return root;
}

function plan(mode: SharedHostingMode, environment = "staging") {
  return createSharedHostingPlan(manifest, {
    application: mode === "php-sftp" ? "php" : "web", environment, sourceRevision: "abcdef1234567", mode,
    host: "host.example.com", user: "deploy", remoteRoot: "/home/deploy/site", healthUrl: "https://site.example.com/health",
  });
}

describe("shared-hosting SFTP deployment", () => {
  it("plans versioned static and PHP uploads without credentials or live-tree paths", () => {
    const staticPlan = plan("static-sftp");
    expect(staticPlan).toMatchObject({ provider: "shared-hosting", mode: "static-sftp", sourceDirectory: "apps/web/dist", remoteRoot: "/home/deploy/site" });
    expect(plan("php-sftp")).toMatchObject({ sourceDirectory: "apps/php", requiredSecretNames: ["DATABASE_URL"] });
    expect(JSON.stringify(staticPlan)).not.toContain("BEGIN");
    expect(() => createSharedHostingPlan(manifest, { application: "web", environment: "staging", sourceRevision: "abcdef1234567", mode: "static-sftp", host: "host.example.com", user: "root", remoteRoot: "/home/deploy/site", healthUrl: "https://site.example.com/health" })).toThrow("root");
    expect(() => createSharedHostingPlan(manifest, { application: "web", environment: "staging", sourceRevision: "main", mode: "static-sftp", host: "host.example.com", user: "deploy", remoteRoot: "/home/deploy/site", healthUrl: "https://site.example.com/health" })).toThrow("commit SHA");
  });

  it("requires exact approval before any remote command", async () => {
    const prepared = plan("static-sftp");
    const runner = new ScriptedRunner();
    await expect(executeSharedHostingPlan(prepared, { approval: "wrong", repositoryRoot: await fixture(), sshKeyPath: "/keys/deploy", runner })).rejects.toThrow("approval");
    expect(runner.calls).toHaveLength(0);
  });

  it("uploads into a versioned directory, switches current only via symlink, and redacts health bodies", async () => {
    const prepared = plan("static-sftp");
    const runner = new ScriptedRunner();
    const result = await executeSharedHostingPlan(prepared, {
      approval: prepared.digest, repositoryRoot: await fixture(), sshKeyPath: "/keys/deploy", runner,
      healthFetch: vi.fn().mockResolvedValue(new Response("secret body is ignored", { status: 200 })),
      now: new Date("2026-08-21T00:00:00.000Z"),
    });
    expect(result.release.status).toBe("healthy");
    expect(runner.calls.some(({ args }) => args.includes("StrictHostKeyChecking=yes"))).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("PasswordAuthentication=no"))).toBe(true);
    expect(runner.calls.some(({ command, args }) => command === "scp" && args.includes("-r") && args.some((arg) => arg.endsWith("/home/deploy/site/releases/abcdef1234567/")))).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("ln") && args.includes("-sfn") && args.includes("/home/deploy/site/current"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret body");
    expect(runner.calls.flatMap(({ args }) => args).join(" ")).not.toContain("ftp://");
  });

  it("refuses to overwrite a live tree that is not a symlink", async () => {
    const prepared = plan("static-sftp");
    const runner = new ScriptedRunner((_command, args) => args.includes("!") || args.includes("-L"));
    await expect(executeSharedHostingPlan(prepared, { approval: prepared.digest, repositoryRoot: await fixture(), sshKeyPath: "/keys/deploy", runner })).rejects.toThrow("live tree");
    expect(runner.calls.some(({ args }) => args.includes("mkdir"))).toBe(false);
  });

  it("requires separate production approval", async () => {
    const prepared = plan("static-sftp", "production");
    await expect(executeSharedHostingPlan(prepared, { approval: prepared.digest, repositoryRoot: await fixture(), sshKeyPath: "/keys/deploy", runner: new ScriptedRunner() })).rejects.toThrow("production approval");
  });

  it("rolls back by repointing current to the preceding immutable release", async () => {
    const healthy = { id: "release-good", application: "web", provider: "shared-hosting", mode: "static-sftp", environment: "staging", sourceRevision: "1111111", planDigest: "one", status: "healthy" as const, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" };
    const failed = { ...healthy, id: "release-bad", sourceRevision: "2222222", planDigest: "two", status: "unhealthy" as const, createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" };
    const rollback = createRollbackPlan([failed, healthy], failed.id);
    const runner = new ScriptedRunner();
    const result = await executeSharedHostingRollback(rollback, [failed, healthy], {
      approval: rollback.digest, host: "host.example.com", user: "deploy", remoteRoot: "/home/deploy/site",
      healthUrl: "https://site.example.com/health", sshKeyPath: "/keys/deploy", runner,
      healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
    });
    expect(result.failed.status).toBe("rolled-back");
    expect(result.release).toMatchObject({ sourceRevision: "1111111", status: "healthy", rollbackOf: "release-bad" });
    expect(runner.calls.some(({ args }) => args.includes("/home/deploy/site/releases/1111111"))).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("ln") && args.includes("-sfn"))).toBe(true);
  });
});
