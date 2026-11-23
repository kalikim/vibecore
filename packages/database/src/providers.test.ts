import { describe, expect, it, vi } from "vitest";
import { createNeonBranchPlan, executeNeonBranchPlan, inspectHostedDatabase } from "./providers.js";

describe("hosted database inspect", () => {
  it("reads Neon project metadata without fetching connection URIs or printing the API key", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ project: { id: "orange-mode-123", name: "shop", region_id: "aws-us-east-1" } }), { status: 200 }));
    const result = await inspectHostedDatabase("neon", { NEON_API_KEY: "neon-secret-key", NEON_PROJECT_ID: "orange-mode-123" }, request);
    expect(result).toMatchObject({ provider: "neon", projectId: "orange-mode-123", name: "shop", region: "aws-us-east-1" });
    expect(request.mock.calls[0]?.[0]).toBe("https://console.neon.tech/api/v2/projects/orange-mode-123");
    expect(JSON.stringify(result)).not.toContain("neon-secret-key");
    expect(JSON.stringify(result)).not.toContain("postgres://");
  });

  it("refuses unknown providers instead of inventing a create API", async () => {
    await expect(inspectHostedDatabase("supabase", { SUPABASE_URL: "https://example.supabase.co" })).rejects.toThrow("neon");
  });

  it("creates a Neon branch on an existing project without returning connection URIs", async () => {
    const plan = createNeonBranchPlan({ projectId: "orange-mode-123", branchName: "preview-sha", environment: "staging" });
    expect(plan.requiredSecretNames).toEqual(["NEON_API_KEY"]);
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      branch: { id: "br-123", name: "preview-sha" },
      endpoints: [{ connection_uri: "postgres://app:secret-pass@host/db" }],
    }), { status: 200 }));
    const result = await executeNeonBranchPlan(plan, { approval: plan.digest, token: "neon-secret-key", request });
    expect(result).toEqual({ provider: "neon", projectId: "orange-mode-123", branchId: "br-123", branchName: "preview-sha" });
    expect(JSON.stringify(result)).not.toContain("secret-pass");
    expect(() => createNeonBranchPlan({ projectId: "orange-mode-123", branchName: "preview-sha", environment: "production" })).not.toThrow();
    const production = createNeonBranchPlan({ projectId: "orange-mode-123", branchName: "preview-sha", environment: "production" });
    await expect(executeNeonBranchPlan(production, { approval: production.digest, token: "neon-secret-key", request })).rejects.toThrow("production");
  });
});
