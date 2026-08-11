import { describe, expect, it } from "vitest";
import { diagnoseDatabaseStack, diagnoseProviderConfiguration } from "./diagnostics.js";

describe("database stack diagnostics", () => {
  it("validates Supabase configuration without returning secret values", () => {
    const secret = "never-print-this-key";
    const result = diagnoseDatabaseStack("postgresql", "prisma", "supabase", {
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_ANON_KEY: secret,
      DATABASE_URL: "postgresql://user:password@db.example.test/app",
    });
    expect(result.diagnostics.some(({ severity }) => severity === "error")).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("password");
  });

  it("supports Atlas with Mongoose and explains Prisma's MongoDB limitation", () => {
    const atlas = diagnoseDatabaseStack("mongodb", "mongoose", "atlas", { MONGODB_URI: "mongodb+srv://cluster.example.test/app" });
    expect(atlas.diagnostics[0]?.code).toBe("database.stack.compatible");
    const prisma = diagnoseDatabaseStack("mongodb", "prisma", "mongodb-atlas", { MONGODB_URI: "mongodb://cluster.example.test/app" });
    expect(prisma.diagnostics.map(({ code }) => code)).toContain("database.mongodb.prisma_migrate_unavailable");
    expect(prisma.diagnostics.map(({ code }) => code)).toContain("database.mongodb_atlas.srv_recommended");
  });

  it("reports missing provider requirements and incomplete API credential pairs", () => {
    const secret = "never-print-neon-secret";
    const diagnostics = diagnoseProviderConfiguration("neon", { NEON_API_KEY: secret });
    expect(diagnostics.map(({ code }) => code)).toContain("database.provider.variable_missing");
    expect(diagnostics.map(({ code }) => code)).toContain("database.provider.credential_pair_incomplete");
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  it("rejects incompatible provider and engine selections", () => {
    const result = diagnoseDatabaseStack("redis", undefined, "supabase", {});
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "database.stack.incompatible", severity: "error" })]));
  });
});
