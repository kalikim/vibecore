import { describe, expect, it } from "vitest";
import type { VibecoreManifest } from "@vibecore/contracts";
import { buildProjectGraph, topologicalApplications } from "./index.js";

function manifest(applications: VibecoreManifest["applications"]): VibecoreManifest {
  return {
    apiVersion: "vibecore.dev/v1alpha1",
    kind: "Application",
    metadata: { name: "graph-test" },
    applications,
    environments: { local: { runtime: "local-process" } },
  };
}

describe("buildProjectGraph", () => {
  it("orders application dependencies before their consumers", () => {
    const graph = buildProjectGraph(manifest({
      web: { type: "web", framework: "next", path: "apps/web", dependsOn: ["api"] },
      api: { type: "api", framework: "hono", path: "apps/api" },
    }));

    expect(graph.diagnostics).toEqual([]);
    expect(topologicalApplications(graph)).toEqual(["api", "web"]);
  });

  it("reports cycles with the complete path", () => {
    const graph = buildProjectGraph(manifest({
      web: { type: "web", framework: "next", path: "apps/web", dependsOn: ["api"] },
      api: { type: "api", framework: "hono", path: "apps/api", dependsOn: ["web"] },
    }));

    expect(graph.diagnostics[0]?.code).toBe("graph.dependency.cycle");
    expect(topologicalApplications(graph)).toEqual([]);
  });
});
