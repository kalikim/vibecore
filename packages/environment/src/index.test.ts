import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VibecoreManifest } from "@vibecore/contracts";
import { parseEnvFile, resolveEnvironment, valuesForApplication } from "./index.js";

const manifest: VibecoreManifest = {
  apiVersion: "vibecore.dev/v1alpha1",
  kind: "Application",
  metadata: { name: "environment-test" },
  applications: {
    api: { type: "api", framework: "hono", path: "apps/api" },
    web: { type: "web", framework: "next", path: "apps/web" },
  },
  variables: {
    DATABASE_URL: { required: true, secret: true, applications: ["api"] },
    PUBLIC_URL: { required: true, applications: ["web"] },
  },
  environments: { local: { runtime: "local-process", variableSources: { default: "env-file" } } },
};

describe("environment contracts", () => {
  it("loads files with process values taking precedence and scopes application values", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-env-"));
    await writeFile(join(root, ".env"), "DATABASE_URL=from-file\nPUBLIC_URL=http://localhost\n");
    const result = await resolveEnvironment(manifest, root, "local", { DATABASE_URL: "from-process" });

    expect(result.values.DATABASE_URL).toBe("from-process");
    expect(result.diagnostics.every(({ severity }) => severity !== "error")).toBe(true);
    expect(valuesForApplication(manifest, "api", result.values)).toEqual({ DATABASE_URL: "from-process" });
    expect(valuesForApplication(manifest, "web", result.values)).toEqual({ PUBLIC_URL: "http://localhost" });
  });

  it("reports missing values and secrets with public prefixes without exposing values", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-env-"));
    const unsafe: VibecoreManifest = {
      ...manifest,
      variables: { EXPO_PUBLIC_TOKEN: { required: true, secret: true } },
    };
    const result = await resolveEnvironment(unsafe, root, "local", {});
    expect(result.diagnostics.map(({ code }) => code).sort()).toEqual([
      "environment.secret.public-prefix",
      "environment.variable.missing",
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toContain("token-value");
  });

  it("parses quoted values without expansion", () => {
    expect(parseEnvFile("A='hello world'\nB=plain # note\nC=$A\n")).toEqual({
      A: "hello world",
      B: "plain",
      C: "$A",
    });
  });
});
