import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectDrizzleMigrations, inspectMikroOrmMigrations, inspectMongoMigrations, inspectMongooseMigrations, inspectTypeOrmMigrations } from "./tooling.js";

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

  it("extracts TypeORM and MikroORM SQL fragments and classifies unparsed scripts as review", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-orm-"));
    await mkdir(join(root, "src/migrations"), { recursive: true });
    await writeFile(join(root, "src/migrations/001.ts"), "await queryRunner.query(`CREATE TABLE users (id int)`);\nawait queryRunner.query(`DROP TABLE users`);");
    await writeFile(join(root, "src/migrations/002.ts"), "export class Mystery implements MigrationInterface { public async up() { await this.compute(); } }");
    const typeorm = await inspectTypeOrmMigrations(root);
    expect(typeorm.migrations[0]?.risk).toBe("destructive");
    expect(typeorm.migrations[1]?.risk).toBe("review");
    await writeFile(join(root, "src/migrations/003.ts"), "this.addSql('CREATE INDEX users_id ON users(id)');");
    const mikro = await inspectMikroOrmMigrations(root);
    expect(mikro.migrations.some(({ findings }) => findings.some(({ code }) => code === "database.migration.additive" || code === "database.migration.lock_or_constraint"))).toBe(true);
  });

  it("inspects Mongoose declarative JSON using the MongoDB operation allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-mongoose-"));
    await mkdir(join(root, "migrations/mongoose"), { recursive: true });
    await writeFile(join(root, "migrations/mongoose/001.json"), JSON.stringify({ operations: [{ type: "createCollection", collection: "users" }] }));
    const result = await inspectMongooseMigrations(root);
    expect(result.tool).toBe("mongoose");
    expect(result.risk).toBe("safe");
  });
});
