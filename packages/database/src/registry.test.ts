import { describe, expect, it } from "vitest";
import { detectDatabaseIntegrations, getDatabaseAdapter, listDatabaseAdapters, resolveDatabaseStack } from "./registry.js";

describe("database adapter registry", () => {
  it("registers separate engine, tool, and hosted-provider layers", () => {
    expect(listDatabaseAdapters("engine").map(({ id }) => id)).toEqual([
      "postgresql", "mysql", "mariadb", "mongodb", "redis", "sqlite", "sqlserver", "cockroachdb",
    ]);
    expect(getDatabaseAdapter("supabase")).toMatchObject({ kind: "provider", engines: ["postgresql"] });
    expect(getDatabaseAdapter("neon")?.capabilities.find(({ capability }) => capability === "provision")?.support).toBe("planned");
  });

  it("resolves compatible stacks and rejects invalid combinations", () => {
    expect(resolveDatabaseStack("postgres", "prisma", "neon").map(({ id }) => id)).toEqual(["postgresql", "prisma", "neon"]);
    expect(() => resolveDatabaseStack("mongodb", "mongoose", "supabase")).toThrow("does not support");
  });

  it("detects integrations without reading secret values", () => {
    const detected = detectDatabaseIntegrations({ "drizzle-orm": "1.0.0", "@supabase/supabase-js": "2.0.0" }, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
    expect(detected.map(({ adapterId }) => adapterId)).toEqual(["drizzle", "supabase"]);
    expect(JSON.stringify(detected)).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
