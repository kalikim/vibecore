import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { DatabaseBackupEvidence, DatabaseMigrationRisk, DatabaseOperation, DatabaseOperationPlan, DatabaseToolName } from "@codexsafari/vibecore-contracts";
import { digestValue } from "@codexsafari/vibecore-planner";

export interface DatabaseCommandRunner {
  run(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface DatabaseOperationResult {
  status: "succeeded";
  output: string;
  commands: Array<{ command: string; args: string[] }>;
  backup?: DatabaseBackupEvidence;
}

const migrateTools = new Set<DatabaseToolName>(["prisma", "drizzle", "mongodb", "typeorm", "mikro-orm"]);
const isoStamp = (now: Date) => now.toISOString().replace(/[:.]/g, "-");

export function createDatabaseMigratePlan(options: {
  tool: DatabaseToolName;
  engine: string;
  environment: string;
  risk: DatabaseMigrationRisk;
  migrationsPath: string;
  migrationChecksums: Array<{ name: string; checksum: string }>;
  schemaPath?: string;
  urlVariableName?: string;
  allowDestructive?: boolean;
  backupChecksum?: string;
}): DatabaseOperationPlan {
  if (!migrateTools.has(options.tool)) throw new Error(`${options.tool} migration execution is not implemented; inspect the files and run the vendor CLI directly`);
  if (options.tool === "prisma" && options.engine === "mongodb") throw new Error("Prisma Migrate does not support MongoDB");
  if (options.tool === "typeorm" && options.engine === "mongodb") throw new Error("TypeORM migration:run does not support MongoDB");
  const urlVariableName = safeVariableName(options.urlVariableName ?? "DATABASE_URL");
  const schemaPath = options.tool === "typeorm"
    ? safeRelativePath(options.schemaPath ?? "src/data-source.ts")
    : options.schemaPath ? safeRelativePath(options.schemaPath) : undefined;
  const command = options.tool === "mongodb" ? undefined : migrateCommand(options.tool, schemaPath);
  const semantic = {
    operation: "migrate" as const, tool: options.tool, engine: options.engine, environment: options.environment, risk: options.risk,
    urlVariableName, requiredSecretNames: [urlVariableName], migrationsPath: safeRelativePath(options.migrationsPath),
    migrationChecksums: options.migrationChecksums, ...(schemaPath ? { schemaPath } : {}),
    ...(options.allowDestructive ? { allowDestructive: true } : {}),
    ...(options.backupChecksum ? { backupChecksum: safeChecksum(options.backupChecksum) } : {}),
    ...(command ? { command } : {}),
  };
  return { ...semantic, digest: digestValue(semantic) };
}

export function createDatabaseSeedPlan(options: { environment: string; engine: string; schemaPath?: string; urlVariableName?: string }): DatabaseOperationPlan {
  const urlVariableName = safeVariableName(options.urlVariableName ?? "DATABASE_URL");
  const command = { executable: "pnpm", args: ["exec", "prisma", "db", "seed"] };
  const semantic = { operation: "seed" as const, tool: "prisma" as const, engine: options.engine, environment: options.environment, risk: "review" as const, urlVariableName, requiredSecretNames: [urlVariableName], ...(options.schemaPath ? { schemaPath: safeRelativePath(options.schemaPath) } : {}), command };
  return { ...semantic, digest: digestValue(semantic) };
}

export function createDatabaseBackupPlan(options: { engine: string; environment: string; urlVariableName?: string }): DatabaseOperationPlan {
  const engine = normalizeEngine(options.engine);
  if (!["postgresql", "mysql", "mariadb", "sqlite", "mongodb"].includes(engine)) throw new Error(`Backup is not implemented for ${options.engine}`);
  const urlVariableName = safeVariableName(options.urlVariableName ?? (engine === "mongodb" ? "MONGODB_URI" : "DATABASE_URL"));
  const semantic = { operation: "backup" as const, engine, environment: options.environment, risk: "safe" as const, urlVariableName, requiredSecretNames: [urlVariableName] };
  return { ...semantic, digest: digestValue(semantic) };
}

export function createDatabaseRestorePlan(options: { engine: string; environment: string; backupPath: string; backupChecksum: string; urlVariableName?: string; allowDestructive?: boolean }): DatabaseOperationPlan {
  const engine = normalizeEngine(options.engine);
  if (!["postgresql", "mysql", "mariadb", "sqlite", "mongodb"].includes(engine)) throw new Error(`Restore is not implemented for ${options.engine}`);
  const urlVariableName = safeVariableName(options.urlVariableName ?? (engine === "mongodb" ? "MONGODB_URI" : "DATABASE_URL"));
  const semantic = {
    operation: "restore" as const, engine, environment: options.environment, risk: "destructive" as const, urlVariableName,
    requiredSecretNames: [urlVariableName], backupPath: safeRelativePath(options.backupPath), backupChecksum: safeChecksum(options.backupChecksum),
    ...(options.allowDestructive ? { allowDestructive: true } : {}),
  };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function executeDatabaseOperationPlan(plan: DatabaseOperationPlan, options: {
  approval: string;
  repositoryRoot: string;
  productionApproved?: boolean;
  environment?: NodeJS.ProcessEnv;
  runner?: DatabaseCommandRunner;
  now?: Date;
}): Promise<DatabaseOperationResult> {
  verifyPlan(plan, options.approval);
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production database operations require explicit production approval");
  if (plan.risk === "destructive" && !plan.allowDestructive) throw new Error("Destructive database operations require --allow-destructive in the approved plan");
  if (plan.environment === "production" && plan.risk === "destructive" && plan.operation === "migrate" && !plan.backupChecksum) throw new Error("Destructive production migrations require a verified backup checksum");
  const env = options.environment ?? process.env;
  const url = requiredSecret(env, plan.urlVariableName);
  const secrets = secretValues(env);
  const { run, commands } = createRunner(options.runner, secrets);
  if (plan.operation === "backup") {
    const backup = await executeBackup(plan, options.repositoryRoot, url, run, options.now ?? new Date());
    return { status: "succeeded", output: `Wrote ${backup.path} (${backup.bytes} bytes)`, commands, backup };
  }
  if (plan.operation === "restore") {
    await executeRestore(plan, options.repositoryRoot, url, run);
    return { status: "succeeded", output: `Restored ${plan.backupPath}`, commands };
  }
  if (plan.operation === "seed") {
    if (!plan.command) throw new Error("Seed plan is missing a command");
    const result = await run(plan.command.executable, plan.command.args, { cwd: options.repositoryRoot, env: { ...env, [plan.urlVariableName]: url } });
    return { status: "succeeded", output: redact(result.stdout + result.stderr, secrets).trim(), commands };
  }
  if (plan.backupChecksum) await verifyBackupChecksum(options.repositoryRoot, plan.backupChecksum);
  if (plan.tool === "mongodb") await applyMongoMigrations(plan, options.repositoryRoot, url, run);
  else {
    if (!plan.command) throw new Error("Migrate plan is missing a command");
    const result = await run(plan.command.executable, plan.command.args, { cwd: options.repositoryRoot, env: { ...env, [plan.urlVariableName]: url } });
    return { status: "succeeded", output: redact(`${result.stdout}${result.stderr}`, secrets).trim(), commands };
  }
  return { status: "succeeded", output: "Applied declarative MongoDB migrations", commands };
}

export class SpawnDatabaseCommandRunner implements DatabaseCommandRunner {
  run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: false, cwd: options.cwd, env: options.env, stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      if (options.stdin !== undefined) { child.stdin?.end(options.stdin); }
      child.once("error", reject);
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  }
}

function createRunner(runner: DatabaseCommandRunner | undefined, secrets: string[]): { run: DatabaseCommandRunner["run"]; commands: Array<{ command: string; args: string[] }> } {
  const impl = runner ?? new SpawnDatabaseCommandRunner();
  const commands: Array<{ command: string; args: string[] }> = [];
  const run: DatabaseCommandRunner["run"] = async (command, args, options) => {
    assertSafeDatabaseInvocation(command, args);
    commands.push({ command, args: args.map((arg) => redact(arg, secrets)) });
    const result = await impl.run(command, args, options);
    if (result.exitCode !== 0) throw new Error(`${command} failed with exit code ${result.exitCode}`);
    return result;
  };
  return { run, commands };
}

async function executeBackup(plan: DatabaseOperationPlan, root: string, url: string, run: DatabaseCommandRunner["run"], now: Date): Promise<DatabaseBackupEvidence> {
  const parsed = parseDatabaseUrl(url, plan.engine);
  const directory = safeRepositoryPath(root, ".vibecore/backups");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = `${isoStamp(now)}-${plan.engine}${backupExtension(plan.engine)}`;
  const absolute = join(directory, filename);
  const relativePath = relative(root, absolute);
  if (plan.engine === "sqlite") {
    if (!parsed.file) throw new Error("SQLite backup requires a file: database URL");
    await copyFile(resolveSqliteFile(root, parsed.file), absolute);
  } else if (plan.engine === "postgresql") {
    await run("pg_dump", ["--no-password", "--format=custom", "--file", absolute], { env: postgresEnv(parsed) });
  } else if (plan.engine === "mysql" || plan.engine === "mariadb") {
    const config = await writeMysqlConfig(parsed);
    try { await run("mysqldump", ["--defaults-extra-file", config, "--single-transaction", "--result-file", absolute, parsed.database ?? ""]); }
    finally { await rm(config, { force: true }); }
  } else {
    await run("mongodump", ["--gzip", `--archive=${absolute}`], { env: { ...process.env, MONGODB_URI: url } });
  }
  await chmod(absolute, 0o600);
  const bytes = (await stat(absolute)).size;
  const checksum = createHash("sha256").update(await readFile(absolute)).digest("hex");
  return { path: relativePath, checksum, engine: plan.engine, createdAt: now.toISOString(), bytes };
}

async function executeRestore(plan: DatabaseOperationPlan, root: string, url: string, run: DatabaseCommandRunner["run"]): Promise<void> {
  if (!plan.backupPath || !plan.backupChecksum) throw new Error("Restore plan lacks a backup path and checksum");
  const backup = await verifyNamedBackup(root, plan.backupPath, plan.backupChecksum);
  const parsed = parseDatabaseUrl(url, plan.engine);
  if (plan.engine === "sqlite") {
    if (!parsed.file) throw new Error("SQLite restore requires a file: database URL");
    await copyFile(backup, resolveSqliteFile(root, parsed.file));
    return;
  }
  if (plan.engine === "postgresql") {
    await run("pg_restore", ["--no-password", "--clean", "--if-exists", "--exit-on-error", "--single-transaction", "--dbname", parsed.database ?? "postgres", backup], { env: postgresEnv(parsed) });
    return;
  }
  if (plan.engine === "mysql" || plan.engine === "mariadb") {
    const config = await writeMysqlConfig(parsed);
    const sql = await readFile(backup, "utf8");
    try { await run("mysql", ["--defaults-extra-file", config, parsed.database ?? ""], { stdin: sql }); }
    finally { await rm(config, { force: true }); }
    return;
  }
  await run("mongorestore", ["--gzip", `--archive=${backup}`, "--drop"], { env: { ...process.env, MONGODB_URI: url } });
}

async function applyMongoMigrations(plan: DatabaseOperationPlan, root: string, url: string, run: DatabaseCommandRunner["run"]): Promise<void> {
  if (!plan.migrationsPath) throw new Error("MongoDB migrate plan lacks a migrations path");
  const directory = safeRepositoryPath(root, plan.migrationsPath);
  const parsed = parseDatabaseUrl(url, "mongodb");
  const script = await buildMongoScript(directory, plan.migrationChecksums ?? [], parsed.database ?? "test");
  const temporary = await mkdtemp(join(tmpdir(), "vibecore-mongo-"));
  const file = join(temporary, "apply.js");
  await writeFile(file, script, { mode: 0o600, flag: "wx" });
  try { await run("mongosh", ["--quiet", "--file", file], { env: { ...process.env, MONGODB_URI: url } }); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

async function buildMongoScript(directory: string, checksums: Array<{ name: string; checksum: string }>, database: string): Promise<string> {
  const lines = [`db = db.getSiblingDB(${JSON.stringify(database)});`];
  for (const expected of checksums) {
    const path = join(directory, expected.name);
    const source = await readFile(path, "utf8");
    if (createHash("sha256").update(source).digest("hex") !== expected.checksum) throw new Error(`MongoDB migration ${expected.name} changed after planning`);
    const document = JSON.parse(source) as { operations?: unknown[] };
    if (!Array.isArray(document.operations)) throw new Error(`${expected.name} must contain an operations array`);
    for (const operation of document.operations) lines.push(mongoStatement(operation));
  }
  return `${lines.join("\n")}\n`;
}

function mongoStatement(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { type?: unknown }).type !== "string") throw new Error("MongoDB operation is invalid");
  const op = value as Record<string, unknown>;
  const collection = jsonString(op.collection, "collection");
  switch (op.type) {
    case "createCollection": return `db.createCollection(${collection});`;
    case "createIndex": return `db.getCollection(${collection}).createIndex(${JSON.stringify(op.keys ?? {})}, ${JSON.stringify({ name: op.name, unique: op.unique === true })});`;
    case "dropIndex": return `db.getCollection(${collection}).dropIndex(${jsonString(op.name, "name")});`;
    case "renameCollection": return `db.getCollection(${collection}).renameCollection(${jsonString(op.newName, "newName")});`;
    case "collMod": return `db.runCommand({ collMod: ${collection}, validator: ${JSON.stringify(op.validator ?? {})} });`;
    case "updateMany":
      if (!op.filter || typeof op.filter !== "object") throw new Error("updateMany requires a filter object");
      return `db.getCollection(${collection}).updateMany(${JSON.stringify(op.filter)}, ${JSON.stringify(op.update ?? {})});`;
    case "deleteMany":
      if (!op.filter || typeof op.filter !== "object") throw new Error("deleteMany requires a filter object");
      return `db.getCollection(${collection}).deleteMany(${JSON.stringify(op.filter)});`;
    case "dropCollection": return `db.getCollection(${collection}).drop();`;
    default: throw new Error(`Unsupported MongoDB operation type: ${String(op.type)}`);
  }
}

function migrateCommand(tool: DatabaseToolName, schemaPath?: string): { executable: string; args: string[] } {
  if (tool === "prisma") return { executable: "pnpm", args: ["exec", "prisma", "migrate", "deploy", `--schema=${safeRelativePath(schemaPath ?? "prisma/schema.prisma")}`] };
  if (tool === "drizzle") return { executable: "pnpm", args: ["exec", "drizzle-kit", "migrate"] };
  if (tool === "typeorm") return { executable: "pnpm", args: ["exec", "typeorm", "migration:run", "-d", safeRelativePath(schemaPath ?? "src/data-source.ts")] };
  if (tool === "mikro-orm") {
    const args = ["exec", "mikro-orm", "migration:up"];
    if (schemaPath) args.push("--config", safeRelativePath(schemaPath));
    return { executable: "pnpm", args };
  }
  return { executable: "mongosh", args: ["--quiet", "--file", "generated"] };
}

function postgresEnv(parsed: ParsedDatabaseUrl): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGHOST: parsed.host ?? "127.0.0.1",
    PGPORT: parsed.port ?? "5432",
    PGUSER: parsed.user ?? "postgres",
    PGDATABASE: parsed.database ?? "postgres",
    ...(parsed.password ? { PGPASSWORD: parsed.password } : {}),
    ...(parsed.sslmode ? { PGSSLMODE: parsed.sslmode } : {}),
  };
}

async function writeMysqlConfig(parsed: ParsedDatabaseUrl): Promise<string> {
  const file = join(tmpdir(), `vibecore-mysql-${createHash("sha256").update(parsed.user ?? "root").digest("hex").slice(0, 12)}.cnf`);
  const body = `[client]\nhost=${parsed.host ?? "127.0.0.1"}\nport=${parsed.port ?? "3306"}\nuser=${parsed.user ?? "root"}\n${parsed.password ? `password=${parsed.password}\n` : ""}`;
  await writeFile(file, body, { mode: 0o600, flag: "wx" });
  return file;
}

interface ParsedDatabaseUrl { host?: string; port?: string; user?: string; password?: string; database?: string; file?: string; sslmode?: string }

export function parseDatabaseUrl(value: string, engine: string): ParsedDatabaseUrl {
  if (engine === "sqlite") {
    const file = value.replace(/^file:/, "");
    if (!file || file.includes("\0")) throw new Error("SQLite file URL is unsafe");
    return { file };
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Database URL is invalid"); }
  if (url.username && url.password === "" && engine !== "mongodb") { /* allow empty password */ }
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")).split("/")[0];
  const sslmode = url.searchParams.get("sslmode");
  return {
    ...(url.hostname ? { host: url.hostname } : {}),
    ...(url.port ? { port: url.port } : {}),
    ...(url.username ? { user: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(database ? { database } : {}),
    ...(sslmode ? { sslmode } : {}),
  };
}

async function verifyBackupChecksum(root: string, checksum: string): Promise<void> {
  const directory = safeRepositoryPath(root, ".vibecore/backups");
  const files = await readdir(directory).catch(() => [] as string[]);
  for (const name of files) {
    const path = join(directory, name);
    try {
      if ((await stat(path)).isFile() && createHash("sha256").update(await readFile(path)).digest("hex") === checksum) return;
    } catch { /* skip unreadable files */ }
  }
  throw new Error("No local backup matches the approved checksum");
}

async function verifyNamedBackup(root: string, relativePath: string, checksum: string): Promise<string> {
  const path = safeRepositoryPath(root, relativePath);
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== checksum) throw new Error("Backup checksum does not match the approved restore plan");
  return path;
}

function verifyPlan(plan: DatabaseOperationPlan, approval: string): void {
  const { digest, ...semantic } = plan;
  if (approval !== digest) throw new Error("Database operation approval does not match the generated digest");
  if (digestValue(semantic) !== digest) throw new Error("Database operation plan was modified after generation");
}

function assertSafeDatabaseInvocation(command: string, args: string[]): void {
  const joined = `${command} ${args.join(" ")}`.toLowerCase();
  if (joined.includes("--password=") || /\s-p[^\s]/.test(joined) || joined.includes("mongodb+srv://") || joined.includes("postgres://") || joined.includes("mysql://")) {
    throw new Error("Database commands must not include credentials or URLs in arguments");
  }
}

function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be supplied through the execution environment`);
  return value;
}

function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = Object.entries(env).filter(([name, value]) => value && /(SECRET|TOKEN|PASSWORD|DATABASE_URL|MONGODB_URI|PRIVATE_KEY)/i.test(name)).map(([, value]) => value as string);
  const extra: string[] = [];
  for (const value of values) {
    extra.push(value);
    try {
      const password = decodeURIComponent(new URL(value).password);
      if (password) extra.push(password);
    } catch { /* value is not a URL */ }
  }
  return extra;
}

function redact(source: string, secrets: string[]): string {
  return secrets.filter(Boolean).sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join("[REDACTED]"), source);
}

function backupExtension(engine: string): string {
  if (engine === "postgresql") return ".dump";
  if (engine === "sqlite") return ".sqlite";
  if (engine === "mongodb") return ".archive.gz";
  return ".sql";
}

function resolveSqliteFile(root: string, file: string): string {
  const relativeFile = file.replace(/^\.\//, "");
  if (isAbsolute(file) || isAbsolute(relativeFile)) throw new Error("SQLite database path must be repository-relative");
  return safeRepositoryPath(root, relativeFile);
}

function jsonString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`MongoDB operation ${label} must be a string`);
  return JSON.stringify(value);
}

function normalizeEngine(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "postgres" || normalized === "postgresql") return "postgresql";
  if (normalized === "maria" || normalized === "mariadb") return "mariadb";
  if (normalized === "mongo" || normalized === "mongodb") return "mongodb";
  return normalized;
}

function safeVariableName(value: string): string { if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) throw new Error("Database URL variable name is unsafe"); return value; }
function safeChecksum(value: string): string { if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Backup checksum must be a SHA-256 hex digest"); return value.toLowerCase(); }
function safeRelativePath(value: string): string { if (!value || value.startsWith("/") || value.includes("..") || !/^[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("Database path must be repository-relative and safe"); return value; }
function safeRepositoryPath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error("Database artifact path must be repository-relative");
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Database artifact path escapes the repository");
  return target;
}

