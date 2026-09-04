import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createDatabaseBackupPlan, createDatabaseMigratePlan, createDatabaseRestorePlan, createDatabaseSeedPlan, executeDatabaseOperationPlan, parseDatabaseUrl, type DatabaseCommandRunner } from "./operations.js";

const checksums = [{ name: "001_init", checksum: "a".repeat(64) }];

class DbRunner implements DatabaseCommandRunner {
  calls: Array<{ command: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  constructor(private readonly fail = false) {}
  async run(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) {
    this.calls.push({ command, args, ...(options?.env ? { env: options.env } : {}) });
    if (this.fail) return { exitCode: 1, stdout: "", stderr: "boom" };
    const fileFlag = args.indexOf("--file");
    const resultFlag = args.indexOf("--result-file");
    const archive = args.find((arg) => arg.startsWith("--archive="));
    const target = fileFlag >= 0 ? args[fileFlag + 1] : resultFlag >= 0 ? args[resultFlag + 1] : archive?.slice("--archive=".length);
    if (target) await writeFile(target, "BACKUP");
    return { exitCode: 0, stdout: "ok postgres://secret-user:secret-pass@localhost/db", stderr: "" };
  }
}

describe("database operation plans", () => {
  it("creates secret-free migrate, seed, backup, and restore plans", () => {
    const migrate = createDatabaseMigratePlan({ tool: "prisma", engine: "postgresql", environment: "staging", risk: "safe", migrationsPath: "prisma/migrations", migrationChecksums: checksums, schemaPath: "prisma/schema.prisma" });
    expect(migrate).toMatchObject({ operation: "migrate", command: { executable: "pnpm", args: ["exec", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"] } });
    expect(JSON.stringify(migrate)).not.toContain("postgres://");
    expect(createDatabaseMigratePlan({ tool: "typeorm", engine: "postgresql", environment: "dev", risk: "safe", migrationsPath: "src/migrations", migrationChecksums: checksums }).command).toEqual({
      executable: "pnpm", args: ["exec", "typeorm", "migration:run", "-d", "src/data-source.ts"],
    });
    expect(createDatabaseMigratePlan({ tool: "mikro-orm", engine: "postgresql", environment: "dev", risk: "safe", migrationsPath: "src/migrations", migrationChecksums: checksums, schemaPath: "mikro-orm.config.ts" }).command).toEqual({
      executable: "pnpm", args: ["exec", "mikro-orm", "migration:up", "--config", "mikro-orm.config.ts"],
    });
    expect(() => createDatabaseMigratePlan({ tool: "mongoose", engine: "mongodb", environment: "dev", risk: "safe", migrationsPath: "migrations/mongoose", migrationChecksums: [] })).toThrow("not implemented");
    expect(() => createDatabaseMigratePlan({ tool: "prisma", engine: "mongodb", environment: "dev", risk: "safe", migrationsPath: "prisma/migrations", migrationChecksums: [] })).toThrow("does not support MongoDB");
    expect(() => createDatabaseMigratePlan({ tool: "typeorm", engine: "mongodb", environment: "dev", risk: "safe", migrationsPath: "src/migrations", migrationChecksums: [] })).toThrow("does not support MongoDB");
    expect(createDatabaseSeedPlan({ environment: "dev", engine: "postgresql" }).operation).toBe("seed");
    expect(createDatabaseBackupPlan({ engine: "postgres", environment: "dev" }).engine).toBe("postgresql");
  });
});

describe("database execution", () => {
  it("runs no command before exact and production approval", async () => {
    const plan = createDatabaseMigratePlan({ tool: "prisma", engine: "postgresql", environment: "production", risk: "safe", migrationsPath: "prisma/migrations", migrationChecksums: checksums, schemaPath: "prisma/schema.prisma" });
    const runner = new DbRunner();
    await expect(executeDatabaseOperationPlan(plan, { approval: "wrong", repositoryRoot: "/repo", runner, environment: { DATABASE_URL: "postgres://localhost/db" } })).rejects.toThrow("approval");
    await expect(executeDatabaseOperationPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", runner, environment: { DATABASE_URL: "postgres://localhost/db" } })).rejects.toThrow("production approval");
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses destructive production migrate without a backup checksum and redacts secrets", async () => {
    const plan = createDatabaseMigratePlan({ tool: "prisma", engine: "postgresql", environment: "production", risk: "destructive", migrationsPath: "prisma/migrations", migrationChecksums: checksums, schemaPath: "prisma/schema.prisma", allowDestructive: true });
    await expect(executeDatabaseOperationPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", productionApproved: true, runner: new DbRunner(), environment: { DATABASE_URL: "postgres://u:secret-pass@localhost/db" } })).rejects.toThrow("backup checksum");
    const allowed = createDatabaseMigratePlan({ tool: "prisma", engine: "postgresql", environment: "staging", risk: "safe", migrationsPath: "prisma/migrations", migrationChecksums: checksums, schemaPath: "prisma/schema.prisma" });
    const runner = new DbRunner();
    const result = await executeDatabaseOperationPlan(allowed, { approval: allowed.digest, repositoryRoot: "/repo", runner, environment: { DATABASE_URL: "postgres://u:secret-pass@localhost/db" } });
    expect(result.output).not.toContain("secret-pass");
    expect(runner.calls[0]?.args).toEqual(["exec", "prisma", "migrate", "deploy", "--schema=prisma/schema.prisma"]);
    expect(runner.calls.flatMap(({ args }) => args).join(" ")).not.toContain("secret-pass");
  });

  it("copies a repository-relative SQLite file and restores it by checksum", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-sqlite-"));
    await writeFile(join(root, "dev.db"), "sqlite-bytes");
    const backupPlan = createDatabaseBackupPlan({ engine: "sqlite", environment: "dev" });
    const backup = await executeDatabaseOperationPlan(backupPlan, { approval: backupPlan.digest, repositoryRoot: root, environment: { DATABASE_URL: "file:./dev.db" } });
    expect(backup.backup?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(backup.backup?.path.startsWith(".vibecore/backups/")).toBe(true);
    await writeFile(join(root, "dev.db"), "changed");
    const restorePlan = createDatabaseRestorePlan({ engine: "sqlite", environment: "dev", backupPath: backup.backup!.path, backupChecksum: backup.backup!.checksum, allowDestructive: true });
    await executeDatabaseOperationPlan(restorePlan, { approval: restorePlan.digest, repositoryRoot: root, environment: { DATABASE_URL: "file:./dev.db" } });
    expect(await readFile(join(root, "dev.db"), "utf8")).toBe("sqlite-bytes");
  });

  it("applies checksum-locked MongoDB operations without putting the URI in arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-mongo-op-"));
    await mkdir(join(root, "migrations/mongodb"), { recursive: true });
    const document = JSON.stringify({ operations: [{ type: "createCollection", collection: "users" }, { type: "createIndex", collection: "users", keys: { email: 1 }, name: "users_email" }] });
    await writeFile(join(root, "migrations/mongodb/001.json"), document);
    const checksum = createHash("sha256").update(document).digest("hex");
    const plan = createDatabaseMigratePlan({ tool: "mongodb", engine: "mongodb", environment: "dev", risk: "safe", migrationsPath: "migrations/mongodb", migrationChecksums: [{ name: "001.json", checksum }] });
    const runner = new DbRunner();
    await executeDatabaseOperationPlan(plan, { approval: plan.digest, repositoryRoot: root, runner, environment: { DATABASE_URL: "mongodb://u:secret-pass@localhost/app" } });
    const mongosh = runner.calls.find(({ command }) => command === "mongosh");
    expect(mongosh?.args).toEqual(["--quiet", "--file", expect.stringContaining("apply.js")]);
    expect(mongosh?.args.join(" ")).not.toContain("secret-pass");
  });

  it("runs TypeORM and MikroORM migrate commands without credentials in arguments", async () => {
    const typeorm = createDatabaseMigratePlan({ tool: "typeorm", engine: "postgresql", environment: "staging", risk: "safe", migrationsPath: "src/migrations", migrationChecksums: checksums, schemaPath: "src/data-source.ts" });
    const mikro = createDatabaseMigratePlan({ tool: "mikro-orm", engine: "postgresql", environment: "staging", risk: "safe", migrationsPath: "src/migrations", migrationChecksums: checksums });
    const runner = new DbRunner();
    await executeDatabaseOperationPlan(typeorm, { approval: typeorm.digest, repositoryRoot: "/repo", runner, environment: { DATABASE_URL: "postgres://u:secret-pass@localhost/db" } });
    await executeDatabaseOperationPlan(mikro, { approval: mikro.digest, repositoryRoot: "/repo", runner, environment: { DATABASE_URL: "postgres://u:secret-pass@localhost/db" } });
    expect(runner.calls[0]?.args).toEqual(["exec", "typeorm", "migration:run", "-d", "src/data-source.ts"]);
    expect(runner.calls[1]?.args).toEqual(["exec", "mikro-orm", "migration:up"]);
    expect(runner.calls.flatMap(({ args }) => args).join(" ")).not.toContain("secret-pass");
    expect(JSON.stringify(typeorm)).not.toContain("secret-pass");
  });
});

describe("database URL parsing", () => {
  it("reads connection fields without requiring them in command arguments", () => {
    const parsed = parseDatabaseUrl("postgres://app:s3cret@db.example.com:5433/shop?sslmode=require", "postgresql");
    expect(parsed).toMatchObject({ user: "app", password: "s3cret", host: "db.example.com", port: "5433", database: "shop", sslmode: "require" });
    expect(parseDatabaseUrl("file:./dev.db", "sqlite").file).toBe("./dev.db");
  });
});
