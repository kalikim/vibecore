import { describe, expect, it } from "vitest";
import type { VibecoreManifest } from "@vibecore/contracts";
import { auditGitHubEnvironments, type GitHubAuditClient } from "./audit.js";
const manifest: VibecoreManifest = { apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "app" }, applications: { api: { type: "api", framework: "hono", path: "." } }, variables: { DATABASE_URL: { required: true, secret: true } }, environments: { dev: { runtime: "local-process" }, staging: { runtime: "github-actions" }, production: { runtime: "github-actions", production: true } } };
describe("GitHub remote audit", () => {
  it("reports environment, secret-name, branch-policy, and reviewer drift", async () => {
    const client: GitHubAuditClient = { listEnvironments: async () => [{ name: "dev", protectedBranches: false, protectionRules: [] }, { name: "staging", protectedBranches: false, protectionRules: [] }, { name: "production", protectedBranches: true, protectionRules: [] }], listEnvironmentSecretNames: async (_repo, environment) => environment === "dev" ? ["DATABASE_URL", "OLD_SECRET"] : [] };
    const audit = await auditGitHubEnvironments(manifest, "owner/repo", client);
    expect(audit.diagnostics.map(({ code }) => code)).toEqual(expect.arrayContaining(["github.environment.secret_unexpected", "github.environment.secret_missing", "github.environment.branch_policy_missing", "github.environment.reviewers_missing"]));
    expect(JSON.stringify(audit)).not.toContain("secret-value");
  });
  it("reports absent standard environments without requesting their secrets", async () => { let secretReads = 0; const client: GitHubAuditClient = { listEnvironments: async () => [], listEnvironmentSecretNames: async () => { secretReads += 1; return []; } }; const audit = await auditGitHubEnvironments(manifest, "owner/repo", client); expect(audit.diagnostics.filter(({ code }) => code === "github.environment.missing")).toHaveLength(3); expect(secretReads).toBe(0); });
});
