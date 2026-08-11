import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectDrizzleMigrations, inspectMongoMigrations } from "./tooling.js";

describe("database tooling inspection", () => {
  it("supports flat and timestamp-directory Drizzle migrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-drizzle-"));
    await mkdir(join(root, "drizzle/002_drop"), { recursive: true });
    await writeFile(join(root, "drizzle/001_init.sql"), "CREATE TABLE users (id INT);");
    await writeFile(join(root, "drizzle/002_drop/migration.sql"), "DROP TABLE users;");
    const result = await inspectDrizzleMigrations(root);
    expect(result.migrations.map(({ risk }) => risk)).toEqual(["safe", "destructive"]);
    expect(result.risk).toBe("destructive");
  });

  it("classifies declarative MongoDB operations without exposing payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-mongo-"));
    await mkdir(join(root, "migrations/mongodb"), { recursive: true });
    await writeFile(join(root, "migrations/mongodb/001.json"), JSON.stringify({ operations: [
      { type: "createIndex", collection: "users", keys: { email: 1 }, secretPayload: "never-print" },
      { type: "collMod", collection: "users", validator: { $jsonSchema: {} } },
      { type: "deleteMany", collection: "users", filter: {} },
    ] }));
    const result = await inspectMongoMigrations(root);
    expect(result.migrations[0]?.findings.map(({ risk }) => risk)).toEqual(["safe", "review", "destructive"]);
    expect(JSON.stringify(result)).not.toContain("never-print");
  });
});
