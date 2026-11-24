import { describe, expect, it } from "vitest";
import type { VibecoreManifest } from "@codexsafari/vibecore-contracts";
import { applyGitHubEnvironmentPlan, createGitHubEnvironmentPlan, type GitHubEnvironmentClient } from "./environments.js";
const manifest: VibecoreManifest = { apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "app" }, applications: { api: { type: "api", framework: "hono", path: "." } }, variables: { DATABASE_URL: { required: true, secret: true } }, environments: { dev: { runtime: "local-process" }, staging: { runtime: "github-actions" }, production: { runtime: "github-actions", production: true } } };
describe("GitHub environments", () => {
  it("plans three environments without secret values", () => {
    const plan = createGitHubEnvironmentPlan(manifest, "owner/repo");
    expect(plan.environments.map(({ name }) => name)).toEqual(["dev", "staging", "production"]);
    expect(JSON.stringify(plan)).not.toContain("postgresql://");
    expect(plan.environments[2]?.body).toMatchObject({ deployment_branch_policy: { protected_branches: true }, prevent_self_review: true });
  });
  it("requires digest and production approval before remote calls", async () => {
    const calls: string[] = [];
    const client: GitHubEnvironmentClient = { putEnvironment: async (_repo, env) => { calls.push(env); }, resolveUserId: async () => 1 };
    const plan = createGitHubEnvironmentPlan(manifest, "owner/repo");
    await expect(applyGitHubEnvironmentPlan(plan, plan.digest, false, client)).rejects.toThrow("production approval");
    expect(calls).toEqual([]);
    expect(await applyGitHubEnvironmentPlan(plan, plan.digest, true, client)).toEqual(["dev", "staging", "production"]);
  });
  it("resolves production reviewer logins to IDs at apply time", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client: GitHubEnvironmentClient = {
      putEnvironment: async (_repo, _env, body) => { bodies.push(body); },
      resolveUserId: async (login) => login === "alice" ? 11 : 22,
    };
    const plan = createGitHubEnvironmentPlan(manifest, "owner/repo", ["bob", "alice"]);
    expect(plan.productionReviewers).toEqual(["alice", "bob"]);
    await applyGitHubEnvironmentPlan(plan, plan.digest, true, client);
    expect(bodies[2]).toMatchObject({ prevent_self_review: true, reviewers: [{ type: "User", id: 11 }, { type: "User", id: 22 }] });
  });
});
