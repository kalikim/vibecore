import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assessMigrationSql, inspectPrismaDatabase } from "./index.js";

describe("Prisma database inspection", () => {
  it("discovers schema metadata and classifies ordered migrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-db-"));
    await mkdir(join(root, "prisma/migrations/001_init"), { recursive: true });
    await mkdir(join(root, "prisma/migrations/002_remove"), { recursive: true });
    await writeFile(join(root, "prisma/schema.prisma"), 'datasource db {\n provider = "postgresql"\n url = env("DATABASE_URL")\n}\n');
    await writeFile(join(root, "prisma/migrations/001_init/migration.sql"), 'CREATE TABLE "User" ("id" TEXT);');
    await writeFile(join(root, "prisma/migrations/002_remove/migration.sql"), 'ALTER TABLE "User" DROP COLUMN "id";');

    const result = await inspectPrismaDatabase(root);
    expect(result).toMatchObject({ datasource: "db", provider: "postgresql", urlEnvironmentVariable: "DATABASE_URL", risk: "destructive" });
    expect(result.migrations.map(({ name, risk }) => ({ name, risk }))).toEqual([
      { name: "001_init", risk: "safe" },
      { name: "002_remove", risk: "destructive" },
    ]);
    expect(result.migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses schema symlinks that escape the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-db-root-"));
    const outside = await mkdtemp(join(tmpdir(), "vibecore-db-outside-"));
    await writeFile(join(outside, "schema.prisma"), 'datasource db { provider = "sqlite" }');
    await symlink(join(outside, "schema.prisma"), join(root, "schema.prisma"));
    await expect(inspectPrismaDatabase(root, "schema.prisma")).rejects.toThrow("escapes the repository");
  });
});

describe("migration SQL assessment", () => {
  it("flags destructive, review, additive, and unknown statements conservatively", () => {
    const findings = assessMigrationSql(`
      CREATE TABLE users (id INT);
      ALTER TABLE users ADD COLUMN nickname TEXT;
      ALTER TABLE users ADD COLUMN email TEXT NOT NULL;
      CREATE UNIQUE INDEX users_id ON users(id);
      DELETE FROM users;
      SELECT 'semi;colon';
    `);
    expect(findings.map((finding) => finding.risk)).toEqual(["safe", "safe", "review", "review", "destructive", "review"]);
  });
});
