import { describe, expect, it } from "vitest";
import type { VibecoreManifest } from "@codexsafari/vibecore-contracts";
import { createExpoBuildPlan, createExpoSubmitPlan, createExpoUpdatePlan, executeExpoEasPlan, type ExpoCommandRunner } from "./expo.js";

const revision = "abcdef1234567";
const manifest: VibecoreManifest = {
  apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "app" },
  applications: { mobile: { type: "mobile", framework: "expo", language: "typescript", path: "apps/mobile" } },
  environments: { dev: { runtime: "local-process" }, staging: { runtime: "github-actions" }, production: { runtime: "github-actions", production: true } },
};

class ExpoRunner implements ExpoCommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly head = revision, private readonly dirty = "") {}
  async run(command: string, args: string[]) {
    this.calls.push({ command, args });
    if (command === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: `${this.head}\n`, stderr: "" };
    if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: this.dirty, stderr: "" };
    return { exitCode: 0, stdout: "https://expo.dev/accounts/demo/builds/1 token-value", stderr: "" };
  }
}

describe("Expo EAS plans", () => {
  it("creates secret-free build and update plans", () => {
    const build = createExpoBuildPlan(manifest, { application: "mobile", environment: "staging", sourceRevision: revision, profile: "preview", platform: "android" });
    expect(build).toMatchObject({ provider: "expo", mode: "eas-build", profile: "preview", requiredSecretNames: ["EXPO_TOKEN"] });
    expect(createExpoUpdatePlan(manifest, { application: "mobile", environment: "production", sourceRevision: revision, channel: "production" }).mode).toBe("eas-update");
    expect(createExpoSubmitPlan(manifest, { application: "mobile", environment: "production", sourceRevision: revision, profile: "production", platform: "ios" }).mode).toBe("eas-submit");
    expect(JSON.stringify(build)).not.toContain("token-value");
  });

  it("runs no EAS command before exact and production approval", async () => {
    const plan = createExpoBuildPlan(manifest, { application: "mobile", environment: "production", sourceRevision: revision, profile: "production" });
    const runner = new ExpoRunner();
    await expect(executeExpoEasPlan(plan, { approval: "wrong", repositoryRoot: "/repo", token: "token-value", runner })).rejects.toThrow("approval");
    await expect(executeExpoEasPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", token: "token-value", runner })).rejects.toThrow("production approval");
    expect(runner.calls).toHaveLength(0);
  });

  it("invokes non-interactive EAS without --local or the token in arguments", async () => {
    const plan = createExpoBuildPlan(manifest, { application: "mobile", environment: "staging", sourceRevision: revision, profile: "preview" });
    const runner = new ExpoRunner();
    const result = await executeExpoEasPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", token: "token-value", runner });
    expect(runner.calls.find(({ command }) => command === "eas")?.args).toEqual(["build", "--non-interactive", "--no-wait", "--profile", "preview", "--platform", "all"]);
    expect(result.release.status).toBe("deploying");
    expect(result.output).not.toContain("token-value");
    expect(runner.calls.flatMap(({ args }) => args)).not.toContain("token-value");
    expect(runner.calls.some(({ args }) => args.includes("--local"))).toBe(false);
  });

  it("submits the latest store build without --local", async () => {
    const plan = createExpoSubmitPlan(manifest, { application: "mobile", environment: "production", sourceRevision: revision, profile: "production", platform: "ios" });
    const runner = new ExpoRunner();
    const result = await executeExpoEasPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", token: "token-value", runner, productionApproved: true });
    expect(runner.calls.find(({ command }) => command === "eas")?.args).toEqual(["submit", "--non-interactive", "--latest", "--profile", "production", "--platform", "ios"]);
    expect(result.release.status).toBe("deploying");
  });
});
