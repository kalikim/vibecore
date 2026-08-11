import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createManifestProposal, scanRepository } from "./index.js";

const fixtureRoot = resolve(import.meta.dirname, "../../../fixtures/reference-stack");

describe("scanRepository", () => {
  it("detects the supported reference stack with evidence", async () => {
    const scan = await scanRepository(fixtureRoot);

    expect(scan.packageManager?.name).toBe("pnpm");
    expect(scan.applications.map(({ framework }) => framework).sort()).toEqual([
      "expo",
      "hono",
      "next",
    ]);
    expect(scan.applications.every(({ confidence, evidence }) => confidence === "high" && evidence.length > 0)).toBe(true);
    expect(scan.resources.map(({ provider }) => provider).sort()).toEqual([
      "docker-compose",
      "postgres",
    ]);
  });

  it("creates a safe manifest proposal without mutating the fixture", async () => {
    const proposal = createManifestProposal(await scanRepository(fixtureRoot));

    expect(proposal.metadata.name).toBe("reference-stack");
    expect(proposal.workspace?.packageManager).toBe("pnpm");
    expect(Object.values(proposal.applications).map(({ framework }) => framework).sort()).toEqual([
      "expo",
      "hono",
      "next",
    ]);
    expect(proposal.environments.local?.runtime).toBe("docker-compose");
    expect(proposal.policies?.requirePlan).toBe(true);
  });
});
