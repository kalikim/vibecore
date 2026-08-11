import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VibecoreManifest } from "@vibecore/contracts";
import { createOpenApiScaffold, listApiDocumentationAdapters, writeOpenApiScaffold } from "./index.js";

const manifest: VibecoreManifest = { apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "shop" }, applications: { api: { type: "api", language: "python", framework: "fastapi", path: "api", health: { path: "/health" } } }, environments: { local: { runtime: "local-process" } } };

describe("OpenAPI scaffolding", () => {
  it("creates a deterministic OpenAPI 3.1 document", () => {
    const first = createOpenApiScaffold(manifest, "api", "api/openapi.yaml");
    const second = createOpenApiScaffold(manifest, "api", "api/openapi.yaml");
    expect(first.digest).toBe(second.digest);
    expect(first.document).toMatchObject({ openapi: "3.1.0", paths: { "/health": {} } });
    expect(listApiDocumentationAdapters().map(({ framework }) => framework)).toContain("aspnet-core");
  });

  it("requires exact approval and refuses overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-openapi-"));
    const scaffold = createOpenApiScaffold(manifest, "api", "api/openapi.yaml");
    await expect(writeOpenApiScaffold(root, scaffold, "wrong")).rejects.toThrow("approval");
    await writeOpenApiScaffold(root, scaffold, scaffold.digest);
    expect(await readFile(join(root, "api/openapi.yaml"), "utf8")).toContain("openapi: 3.1.0");
    await expect(writeOpenApiScaffold(root, scaffold, scaffold.digest)).rejects.toMatchObject({ code: "EEXIST" });
  });
});
