import { resolve } from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createManifestProposal, listLanguageAdapters, scanRepository } from "./index.js";

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
});
