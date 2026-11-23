import { join, resolve } from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createBlueprintManifest, createManifestProposal, inspectExpoProject, listBlueprints, listLanguageAdapters, scanRepository } from "./index.js";

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
    expect(scan.applications.find(({ framework }) => framework === "next")?.commands?.dev).toBe("pnpm dev");
  });

  it("detects the recommended non-Node language frameworks", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "vibecore-languages-"));
    const fixtures: Array<[string, string]> = [
      ["python/pyproject.toml", "dependencies = ['fastapi']"],
      ["go/go.mod", "require github.com/gin-gonic/gin v1.10.0"],
      ["php/composer.json", '{"require":{"laravel/framework":"^12"}}'],
      ["rust/Cargo.toml", '[dependencies]\naxum = "0.8"'],
      ["java/pom.xml", "<artifactId>spring-boot-starter-web</artifactId>"],
      ["kotlin/build.gradle.kts", "plugins { kotlin(\"jvm\"); id(\"org.springframework.boot\") }"],
      ["dotnet/App.csproj", '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>'],
    ];
    for (const [path, source] of fixtures) {
      await mkdir(resolve(root, path, ".."), { recursive: true });
      await writeFile(resolve(root, path), source);
    }
    const scan = await scanRepository(root);
    expect(scan.applications.map(({ framework }) => framework).sort()).toEqual(["aspnet-core", "axum", "fastapi", "gin", "laravel", "spring-boot", "spring-boot"]);
    expect(scan.applications.map(({ language }) => language).sort()).toEqual(["dotnet", "go", "java", "kotlin", "php", "python", "rust"]);
    expect(listLanguageAdapters().map(({ id }) => id)).toContain("python");
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
    expect(proposal.environments.dev?.runtime).toBe("docker-compose");
    expect(proposal.environments.staging?.runtime).toBe("github-actions");
    expect(proposal.environments.production?.production).toBe(true);
    expect(proposal.applications.web?.commands?.build).toBe("pnpm build");
    expect(proposal.policies?.requirePlan).toBe(true);
  });

  it("detects TypeORM, MikroORM, Mongoose, and Drizzle when Prisma is absent", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "vibecore-orm-detect-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "orm-app", dependencies: { typeorm: "0.3.0" } }));
    const scan = await scanRepository(root);
    expect(scan.resources.find(({ name }) => name === "database")).toMatchObject({ config: { orm: "typeorm" }, provider: "postgres" });
  });
});

describe("blueprints", () => {
  it("creates a secret-free reference manifest without application source", () => {
    expect(listBlueprints().map(({ id }) => id)).toEqual(["reference", "web-api"]);
    const manifest = createBlueprintManifest("reference", "My App");
    expect(manifest.metadata.name).toBe("my-app");
    expect(Object.keys(manifest.applications)).toEqual(["web", "api", "mobile"]);
    expect(createBlueprintManifest("web-api", "shop").applications.mobile).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("postgres://");
    expect(() => createBlueprintManifest("unknown", "app")).toThrow("Unknown blueprint");
  });
});

describe("expo inspection", () => {
  it("classifies EAS profiles and does not print secret values", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-expo-"));
    await mkdir(join(root, "apps/mobile"), { recursive: true });
    await writeFile(join(root, "apps/mobile/eas.json"), JSON.stringify({
      build: {
        preview: { channel: "preview", distribution: "internal" },
        production: { channel: "production", distribution: "store" },
      },
    }));
    await writeFile(join(root, "apps/mobile/app.json"), JSON.stringify({ expo: { extra: { EXPO_PUBLIC_API_URL: "https://api.example.com", eas: { projectId: "11111111-1111-1111-1111-111111111111" } } } }));
    const inspection = await inspectExpoProject(root);
    expect(inspection.profiles.map(({ name, channel }) => `${name}:${channel}`)).toEqual(["preview:preview", "production:production"]);
    expect(inspection.publicVariableNames).toEqual(["EXPO_PUBLIC_API_URL"]);
    expect(inspection.diagnostics.some(({ severity }) => severity === "error")).toBe(false);
    expect(JSON.stringify(inspection)).not.toContain("password");
  });

  it("errors when production and preview share a channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-expo-bad-"));
    await mkdir(join(root, "apps/mobile"), { recursive: true });
    await writeFile(join(root, "apps/mobile/eas.json"), JSON.stringify({ build: { preview: { channel: "shared" }, production: { channel: "shared" } } }));
    const inspection = await inspectExpoProject(root);
    expect(inspection.diagnostics.some(({ code }) => code === "expo.eas.channel_collision")).toBe(true);
  });
});
