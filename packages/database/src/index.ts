import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type {
  DatabaseMigrationFinding,
  DatabaseMigrationInspection,
  DatabaseMigrationRisk,
  PrismaDatabaseInspection,
  PrismaLiveCheck,
} from "@vibecore/contracts";
export * from "./registry.js";
export * from "./diagnostics.js";
export * from "./local-runtime.js";

const riskOrder: Record<DatabaseMigrationRisk, number> = { safe: 0, review: 1, destructive: 2 };

export async function inspectPrismaDatabase(
  repositoryRoot: string,
  schemaInput = "prisma/schema.prisma",
): Promise<PrismaDatabaseInspection> {
  const root = await realpath(repositoryRoot);
  const schemaPath = await resolveExistingInside(root, schemaInput);
  const source = await readFile(schemaPath, "utf8");
  const datasourceMatch = /datasource\s+([A-Za-z_]\w*)\s*\{([\s\S]*?)\}/m.exec(source);
  if (!datasourceMatch) throw new Error(`No Prisma datasource block was found in ${relative(root, schemaPath)}`);

  const body = datasourceMatch[2] ?? "";
  const provider = /\bprovider\s*=\s*"([^"]+)"/.exec(body)?.[1];
  if (!provider) throw new Error(`The Prisma datasource in ${relative(root, schemaPath)} has no literal provider`);
  const urlEnvironmentVariable = /\burl\s*=\s*env\(\s*"([^"]+)"\s*\)/.exec(body)?.[1];
  const migrationsPath = join(dirname(schemaPath), "migrations");
  const migrations = await inspectMigrationDirectory(root, migrationsPath);
  const diagnostics = [];

  if (provider === "mongodb") {
    diagnostics.push({
      code: "database.prisma.migrate_unsupported",
      severity: "warning" as const,
      component: "database",
      message: "Prisma Migrate does not support MongoDB; use a provider-specific workflow.",
    });
  }
  if (!urlEnvironmentVariable) {
    diagnostics.push({
      code: "database.prisma.url_not_env",
      severity: "warning" as const,
      component: "database",
      message: "The datasource URL is not declared with env(\"...\"); Vibecore cannot verify its secret contract.",
    });
  }
  if (migrations.length === 0) {
    diagnostics.push({
      code: "database.prisma.no_migrations",
      severity: "info" as const,
      component: "database",
      message: "No local Prisma migration SQL files were found.",
    });
  }

  return {
    schemaPath: relative(root, schemaPath),
    datasource: datasourceMatch[1] ?? "db",
    provider,
    ...(urlEnvironmentVariable ? { urlEnvironmentVariable } : {}),
    migrationsPath: relative(root, migrationsPath),
    migrations,
    risk: highestRisk(migrations.map((migration) => migration.risk)),
    diagnostics,
  };
}

async function inspectMigrationDirectory(root: string, migrationsPath: string): Promise<DatabaseMigrationInspection[]> {
  try {
    if (!(await stat(migrationsPath)).isDirectory()) return [];
  } catch {
    return [];
  }

  const entries = await readdir(migrationsPath, { withFileTypes: true });
  const migrations: DatabaseMigrationInspection[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const sqlPath = await resolveExistingInside(root, join(migrationsPath, entry.name, "migration.sql"));
    const sql = await readFile(sqlPath, "utf8");
    const findings = assessMigrationSql(sql);
    migrations.push({
      name: entry.name,
      path: relative(root, sqlPath),
      checksum: createHash("sha256").update(sql).digest("hex"),
      risk: highestRisk(findings.map((finding) => finding.risk)),
      findings,
    });
  }
  return migrations;
}

export function assessMigrationSql(sql: string): DatabaseMigrationFinding[] {
  const statements = splitSqlStatements(sql);
  return statements.map((statement) => classifyStatement(statement));
}

function classifyStatement(statement: string): DatabaseMigrationFinding {
  const normalized = statement.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").trim();
  const display = normalized.slice(0, 240);
  if (/\b(DROP\s+(TABLE|SCHEMA|DATABASE)|TRUNCATE\b|DROP\s+COLUMN\b)/i.test(normalized)) {
    return finding("destructive", "database.migration.data_loss", "This statement can irreversibly remove stored data.", display);
  }
  if (/^(DELETE\s+FROM|UPDATE\s+)/i.test(normalized) && !/\bWHERE\b/i.test(normalized)) {
    return finding("destructive", "database.migration.unbounded_write", "This statement changes every row because it has no WHERE clause.", display);
  }
  if (/^ALTER\s+TABLE\s+.+\s+ADD\s+COLUMN\b/i.test(normalized) && !/\bNOT\s+NULL\b/i.test(normalized)) {
    return finding("safe", "database.migration.additive", "This appears to be an additive schema change.", display);
  }
  if (/\bALTER\s+(TABLE|COLUMN|TYPE)\b|\bRENAME\b|\bCREATE\s+UNIQUE\s+INDEX\b|\bSET\s+NOT\s+NULL\b/i.test(normalized)) {
    return finding("review", "database.migration.lock_or_constraint", "Review this schema change for locks, constraint failures, and compatibility.", display);
  }
  if (/^CREATE\s+(TABLE|INDEX|SCHEMA|TYPE)\b/i.test(normalized)) {
    return finding("safe", "database.migration.additive", "This appears to be an additive schema change.", display);
  }
  return finding("review", "database.migration.unknown_sql", "Vibecore does not recognize this SQL as safely additive; review it manually.", display);
}

function finding(risk: DatabaseMigrationRisk, code: string, message: string, statement: string): DatabaseMigrationFinding {
  return { risk, code, message, statement };
}

function splitSqlStatements(sql: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";
    if (lineComment) {
      current += char;
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === "*" && next === "/") { current += next; index += 1; blockComment = false; }
      continue;
    }
    if (!quote && char === "-" && next === "-") { current += char + next; index += 1; lineComment = true; continue; }
    if (!quote && char === "/" && next === "*") { current += char + next; index += 1; blockComment = true; continue; }
    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      if (quote === char && next === char) { current += char + next; index += 1; continue; }
      quote = quote === char ? null : char;
    }
    if (char === ";" && !quote) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}

function highestRisk(risks: DatabaseMigrationRisk[]): DatabaseMigrationRisk {
  return risks.reduce<DatabaseMigrationRisk>((highest, risk) => riskOrder[risk]! > riskOrder[highest]! ? risk : highest, "safe");
}

async function resolveExistingInside(root: string, input: string): Promise<string> {
  const candidate = isAbsolute(input) ? input : resolve(root, input);
  const resolved = await realpath(candidate);
  const relation = relative(root, resolved);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`Database path escapes the repository: ${input}`);
  return resolved;
}

export async function runPrismaLiveCheck(
  repositoryRoot: string,
  schemaPath: string,
  command: PrismaLiveCheck["command"],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PrismaLiveCheck> {
  const args = command === "validate"
    ? ["exec", "prisma", "validate", `--schema=${schemaPath}`]
    : command === "status"
      ? ["exec", "prisma", "migrate", "status", `--schema=${schemaPath}`]
      : ["exec", "prisma", "migrate", "diff", "--from-config-datasource", `--to-schema=${schemaPath}`, "--exit-code"];
  const result = await capture("pnpm", args, repositoryRoot, environment);
  const secrets = Object.entries(environment)
    .filter(([name, value]) => value && /(SECRET|TOKEN|PASSWORD|DATABASE_URL|PRIVATE_KEY)/i.test(name))
    .map(([, value]) => value as string);
  const output = secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), `${result.stdout}${result.stderr}`.trim());
  return {
    command,
    status: command === "drift" && result.exitCode === 2 ? "changes-detected" : result.exitCode === 0 ? "in-sync" : "failed",
    exitCode: result.exitCode,
    output,
  };
}

async function capture(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolveResult({ exitCode: code ?? 1, stdout, stderr }));
  });
}
