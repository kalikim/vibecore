import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { DatabaseMigrationFinding, DatabaseMigrationInspection, DatabaseMigrationRisk, DatabaseToolInspection, Diagnostic } from "@vibecore/contracts";
import { assessMigrationSql } from "./index.js";

const order: Record<DatabaseMigrationRisk, number> = { safe: 0, review: 1, destructive: 2 };

export async function inspectDrizzleMigrations(rootInput: string, pathInput = "drizzle"): Promise<DatabaseToolInspection> {
  const root = await realpath(rootInput);
  const directory = await inside(root, pathInput);
  const files = await sqlFiles(directory);
  const migrations: DatabaseMigrationInspection[] = [];
  for (const file of files) {
    const sql = await readFile(file, "utf8");
    const findings = assessMigrationSql(sql);
    migrations.push(migration(relative(directory, file), relative(root, file), sql, findings));
  }
  const diagnostics: Diagnostic[] = files.length ? [] : [{ code: "database.drizzle.no_migrations", severity: "info", component: "drizzle", message: "No Drizzle SQL migration files were found." }];
  return inspection("drizzle", relative(root, directory), migrations, diagnostics);
}

export async function inspectTypeOrmMigrations(rootInput: string, pathInput = "src/migrations"): Promise<DatabaseToolInspection> {
  return inspectScriptMigrations(rootInput, pathInput, "typeorm", [".query(", "queryRunner.query("]);
}

export async function inspectMikroOrmMigrations(rootInput: string, pathInput = "src/migrations"): Promise<DatabaseToolInspection> {
  return inspectScriptMigrations(rootInput, pathInput, "mikro-orm", [".addSql(", "this.addSql("]);
}

export async function inspectMongooseMigrations(rootInput: string, pathInput = "migrations/mongoose"): Promise<DatabaseToolInspection> {
  try {
    const result = await inspectMongoMigrations(rootInput, pathInput);
    return { ...result, tool: "mongoose" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      tool: "mongoose",
      path: pathInput,
      migrations: [],
      risk: "review",
      diagnostics: [{ code: "database.mongoose.no_migrations", severity: "info", component: "mongoose", message: `No declarative Mongoose/MongoJSON migrations were found at ${pathInput}. ${message}` }],
    };
  }
}

async function inspectScriptMigrations(rootInput: string, pathInput: string, tool: "typeorm" | "mikro-orm", markers: string[]): Promise<DatabaseToolInspection> {
  const root = await realpath(rootInput);
  const directory = await inside(root, pathInput);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.(sql|ts|js)$/.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const migrations: DatabaseMigrationInspection[] = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    const source = await readFile(file, "utf8");
    const sql = entry.name.endsWith(".sql") ? source : extractSqlFragments(source, markers).join(";\n");
    const findings = sql.trim()
      ? assessMigrationSql(sql)
      : [finding("review", "database.migration.unparsed_script", `${tool} TypeScript/JavaScript migrations with no extractable SQL require manual review`, entry.name)];
    migrations.push(migration(entry.name, relative(root, file), source, findings));
  }
  const diagnostics: Diagnostic[] = entries.length ? [] : [{ code: `database.${tool.replace("-", "")}.no_migrations`, severity: "info", component: tool, message: `No ${tool} migration files were found.` }];
  return inspection(tool, relative(root, directory), migrations, diagnostics);
}

function extractSqlFragments(source: string, markers: string[]): string[] {
  const fragments: string[] = [];
  for (const marker of markers) {
    let index = 0;
    while (index < source.length) {
      const start = source.indexOf(marker, index);
      if (start === -1) break;
      const open = source.indexOf("(", start);
      if (open === -1) break;
      const quote = source[open + 1];
      if (quote !== "`" && quote !== "'" && quote !== '"') { index = open + 1; continue; }
      const { text, next } = readQuoted(source, open + 1, quote);
      if (text.trim()) fragments.push(text);
      index = next;
    }
  }
  return fragments;
}

function readQuoted(source: string, start: number, quote: string): { text: string; next: number } {
  let text = "";
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (char === "\\" && quote !== "`") { text += source[index + 1] ?? ""; index += 1; continue; }
    if (quote === "`" && char === "\\" && source[index + 1] === "`") { text += "`"; index += 1; continue; }
    if (char === quote) return { text, next: index + 1 };
    text += char;
  }
  return { text, next: source.length };
}

export async function inspectMongoMigrations(rootInput: string, pathInput = "migrations/mongodb"): Promise<DatabaseToolInspection> {
  const root = await realpath(rootInput);
  const directory = await inside(root, pathInput);
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
  const migrations: DatabaseMigrationInspection[] = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    const source = await readFile(file, "utf8");
    const document: unknown = JSON.parse(source);
    if (!isRecord(document) || !Array.isArray(document.operations)) throw new Error(`${relative(root, file)} must contain an operations array`);
    const findings = document.operations.map((operation, index) => classifyMongoOperation(operation, index));
    migrations.push(migration(entry.name, relative(root, file), source, findings));
  }
  const diagnostics: Diagnostic[] = entries.length ? [] : [{ code: "database.mongodb.no_migrations", severity: "info", component: "mongodb", message: "No declarative MongoDB migration files were found." }];
  return inspection("mongodb", relative(root, directory), migrations, diagnostics);
}

function classifyMongoOperation(value: unknown, index: number): DatabaseMigrationFinding {
  if (!isRecord(value) || typeof value.type !== "string") return finding("destructive", "database.mongodb.invalid_operation", `Operation ${index + 1} has no supported type`, "invalid operation");
  const statement = JSON.stringify(redactMongoOperation(value)).slice(0, 240);
  if (["dropCollection", "deleteMany"].includes(value.type)) return finding("destructive", "database.mongodb.data_loss", `${value.type} can irreversibly remove documents`, statement);
  if (value.type === "updateMany" && !isRecord(value.filter)) return finding("destructive", "database.mongodb.unbounded_update", "updateMany requires an explicit filter object", statement);
  if (["collMod", "renameCollection", "dropIndex", "updateMany"].includes(value.type)) return finding("review", "database.mongodb.review", `${value.type} requires compatibility and data review`, statement);
  if (["createCollection", "createIndex"].includes(value.type)) return finding("safe", "database.mongodb.additive", `${value.type} is additive`, statement);
  return finding("destructive", "database.mongodb.unknown_operation", `Unsupported MongoDB operation type: ${value.type}`, statement);
}

function redactMongoOperation(value: Record<string, unknown>): Record<string, unknown> {
  const allowed = ["type", "collection", "name", "newName", "unique", "validationLevel", "validationAction"];
  return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.includes(key)));
}

async function sqlFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".sql")) files.push(path);
    if (entry.isDirectory() && entry.name !== "meta") {
      const migrationSql = join(path, "migration.sql");
      try { if ((await stat(migrationSql)).isFile()) files.push(migrationSql); } catch { /* not a current Drizzle migration folder */ }
    }
  }
  return files;
}

async function inside(root: string, input: string): Promise<string> {
  const candidate = isAbsolute(input) ? input : resolve(root, input);
  const path = await realpath(candidate);
  const relation = relative(root, path);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`Migration path escapes the repository: ${input}`);
  if (!(await stat(path)).isDirectory()) throw new Error(`Migration path is not a directory: ${input}`);
  return path;
}

function migration(name: string, path: string, source: string, findings: DatabaseMigrationFinding[]): DatabaseMigrationInspection {
  return { name, path, checksum: createHash("sha256").update(source).digest("hex"), risk: highest(findings.map(({ risk }) => risk)), findings };
}

function inspection(tool: DatabaseToolInspection["tool"], path: string, migrations: DatabaseMigrationInspection[], diagnostics: Diagnostic[]): DatabaseToolInspection {
  return { tool, path, migrations, risk: highest(migrations.map(({ risk }) => risk)), diagnostics };
}

function highest(risks: DatabaseMigrationRisk[]): DatabaseMigrationRisk { return risks.reduce<DatabaseMigrationRisk>((a, b) => order[b]! > order[a]! ? b : a, "safe"); }
function finding(risk: DatabaseMigrationRisk, code: string, message: string, statement: string): DatabaseMigrationFinding { return { risk, code, message, statement }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
