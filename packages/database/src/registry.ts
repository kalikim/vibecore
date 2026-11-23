import type {
  CapabilitySupport,
  DatabaseAdapterCapability,
  DatabaseAdapterKind,
  DatabaseAdapterMetadata,
  DatabaseCapability,
  DetectedDatabaseIntegration,
  DetectionEvidence,
} from "@vibecore/contracts";

const capabilityOrder: DatabaseCapability[] = [
  "detect", "inspect", "validate", "local-runtime", "provision", "deploy-migrations", "backup", "branching",
];

function capabilities(values: Partial<Record<DatabaseCapability, [CapabilitySupport, string]>>): DatabaseAdapterCapability[] {
  return capabilityOrder.map((capability) => {
    const [support, note] = values[capability] ?? ["unsupported", "This capability does not apply to this adapter."];
    return { capability, support, note };
  });
}

const adapters: DatabaseAdapterMetadata[] = [
  engine("postgresql", "PostgreSQL", {
    detect: ["implemented", "Detected through manifests, Prisma schemas, and Compose."],
    inspect: ["implemented", "Prisma migration SQL can be inspected offline."],
    validate: ["implemented", "Read-only Prisma validation, status, and drift checks."],
    "local-runtime": ["implemented", "Project-scoped Docker Compose lifecycle."],
    provision: ["planned", "Managed provisioning belongs to provider adapters."],
    "deploy-migrations": ["implemented", "Exact-approved Prisma, Drizzle, TypeORM, or MikroORM migrate."],
    backup: ["implemented", "pg_dump custom-format backups with checksum evidence."],
  }),
  engine("mysql", "MySQL", {
    detect: ["implemented", "Detected when Prisma declares the mysql provider."],
    inspect: ["implemented", "Prisma migration SQL can be inspected offline."],
    validate: ["implemented", "Read-only Prisma CLI checks are available."],
    "local-runtime": ["planned", "A Compose runtime adapter is planned."],
    "deploy-migrations": ["implemented", "Exact-approved Prisma, Drizzle, TypeORM, or MikroORM migrate."],
    backup: ["implemented", "mysqldump backups use a temporary defaults file; passwords are never CLI arguments."],
  }),
  engine("mariadb", "MariaDB", {
    detect: ["implemented", "Resolved from explicit resource configuration; Prisma uses its mysql connector."],
    inspect: ["implemented", "MySQL-compatible Prisma migration SQL can be inspected offline."],
    validate: ["implemented", "Read-only checks use Prisma's mysql connector."],
    "local-runtime": ["planned", "A Compose runtime adapter is planned."],
    "deploy-migrations": ["implemented", "Exact-approved Prisma, Drizzle, TypeORM, or MikroORM migrate."],
    backup: ["implemented", "mysqldump backups use a temporary defaults file; passwords are never CLI arguments."],
  }),
  engine("mongodb", "MongoDB", {
    detect: ["implemented", "Detected when Prisma or Mongoose declares MongoDB usage."],
    inspect: ["implemented", "Declarative JSON migration files are checksummed and risk classified."],
    validate: ["implemented", "Prisma schema validation works; Prisma Migrate does not."],
    "local-runtime": ["planned", "A replica-set capable local adapter is planned."],
    provision: ["planned", "Provisioning belongs to MongoDB Atlas or another provider adapter."],
    "deploy-migrations": ["implemented", "Exact-approved mongosh JSON operations or MikroORM migration:up."],
    backup: ["implemented", "mongodump archive backups using MONGODB_URI in the process environment."],
  }),
  engine("redis", "Redis", {
    detect: ["implemented", "Detected through manifests and Compose services."],
    inspect: ["planned", "Key policy and persistence inspection are pending."],
    validate: ["planned", "Connectivity and persistence diagnostics are pending."],
    "local-runtime": ["implemented", "Project-scoped Docker Compose lifecycle."],
    provision: ["planned", "Managed provisioning belongs to provider adapters."],
    backup: ["planned", "Persistence and backup policy verification are pending."],
  }),
  engine("sqlite", "SQLite", {
    detect: ["implemented", "Detected when Prisma declares the sqlite provider."],
    inspect: ["implemented", "Prisma migration SQL can be inspected offline."],
    validate: ["implemented", "Read-only Prisma CLI checks are available."],
    "local-runtime": ["implemented", "SQLite runs as a repository-scoped file without a service container."],
    "deploy-migrations": ["implemented", "Exact-approved Prisma, Drizzle, TypeORM, or MikroORM migrate."],
    backup: ["implemented", "Repository-relative SQLite file copy with checksum evidence."],
  }),
  engine("sqlserver", "Microsoft SQL Server", {
    detect: ["implemented", "Detected when Prisma declares the sqlserver provider."],
    inspect: ["implemented", "Prisma migration SQL can be inspected offline."],
    validate: ["implemented", "Read-only Prisma CLI checks are available."],
    "local-runtime": ["planned", "A Compose runtime adapter is planned."],
    "deploy-migrations": ["implemented", "Exact-approved Prisma migrate deploy or TypeORM migration:run."],
    backup: ["planned", "Backup evidence and restore verification are pending."],
  }),
  engine("cockroachdb", "CockroachDB", {
    detect: ["implemented", "Detected when Prisma declares the cockroachdb provider."],
    inspect: ["implemented", "Prisma migration SQL can be inspected offline."],
    validate: ["implemented", "Read-only Prisma CLI checks are available."],
    "local-runtime": ["planned", "A local cluster adapter is planned."],
    provision: ["planned", "A managed provider adapter is planned."],
    "deploy-migrations": ["implemented", "Exact-approved Prisma migrate deploy."],
    backup: ["planned", "Backup evidence and restore verification are pending."],
  }),
  tool("prisma", "Prisma", ["postgresql", "mysql", "mariadb", "sqlite", "sqlserver", "cockroachdb", "mongodb"], {
    detect: ["implemented", "Detected from dependencies and schema.prisma."],
    inspect: ["implemented", "Migration SQL is checksummed and risk classified."],
    validate: ["implemented", "Schema, migration status, and relational drift checks are read-only."],
    "deploy-migrations": ["implemented", "prisma migrate deploy after exact digest approval."],
    backup: ["implemented", "Backup and restore are delegated to the engine adapter."],
  }),
  tool("drizzle", "Drizzle ORM", ["postgresql", "mysql", "sqlite"], {
    detect: ["implemented", "Detected from drizzle-orm or drizzle-kit dependencies."],
    inspect: ["implemented", "SQL files and timestamped migration.sql directories are classified."],
    validate: ["planned", "Live Drizzle validation remains pending."],
    "deploy-migrations": ["implemented", "drizzle-kit migrate after exact digest approval."],
  }),
  tool("typeorm", "TypeORM", ["postgresql", "mysql", "mariadb", "sqlite", "sqlserver", "mongodb"], {
    detect: ["implemented", "Detected from the typeorm dependency."],
    inspect: ["implemented", "SQL files and query() fragments are classified; unparsed TypeScript requires review."],
    validate: ["planned", "Live TypeORM validation remains pending."],
    "deploy-migrations": ["implemented", "typeorm migration:run -d <datasource> after exact digest approval. schema:sync and migration:revert are not wrapped."],
  }),
  tool("mikro-orm", "MikroORM", ["postgresql", "mysql", "mariadb", "sqlite", "mongodb"], {
    detect: ["implemented", "Detected from @mikro-orm packages."],
    inspect: ["implemented", "SQL files and addSql() fragments are classified; unparsed TypeScript requires review."],
    validate: ["planned", "Live MikroORM validation remains pending."],
    "deploy-migrations": ["implemented", "mikro-orm migration:up after exact digest approval. migration:down is not wrapped."],
  }),
  tool("mongoose", "Mongoose", ["mongodb"], {
    detect: ["implemented", "Detected from the mongoose dependency."],
    inspect: ["implemented", "Declarative JSON migrations are classified using the MongoDB operation allowlist."],
    validate: ["planned", "Live Mongoose validation remains pending."],
    "deploy-migrations": ["planned", "Use the mongodb tooling adapter to apply declarative JSON operations."],
  }),
  provider("supabase", "Supabase", ["postgresql"], ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "DATABASE_URL"], "https://supabase.com/docs", true),
  provider("neon", "Neon", ["postgresql"], ["DATABASE_URL", "NEON_API_KEY", "NEON_PROJECT_ID"], "https://neon.com/docs", true),
  provider("mongodb-atlas", "MongoDB Atlas", ["mongodb"], ["MONGODB_URI", "ATLAS_PUBLIC_KEY", "ATLAS_PRIVATE_KEY"], "https://www.mongodb.com/docs/atlas/", false),
  provider("planetscale", "PlanetScale", ["mysql"], ["DATABASE_URL", "PLANETSCALE_SERVICE_TOKEN"], "https://planetscale.com/docs", true),
  provider("upstash", "Upstash", ["redis"], ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"], "https://upstash.com/docs", false),
  provider("railway", "Railway", ["postgresql", "mysql", "mariadb", "mongodb", "redis"], ["DATABASE_URL", "RAILWAY_TOKEN", "RAILWAY_PROJECT_ID"], "https://docs.railway.com", false),
];

function engine(id: string, displayName: string, values: Partial<Record<DatabaseCapability, [CapabilitySupport, string]>>): DatabaseAdapterMetadata {
  return { id, displayName, kind: "engine", engines: [id], capabilities: capabilities(values) };
}

function tool(id: string, displayName: string, engines: string[], values: Partial<Record<DatabaseCapability, [CapabilitySupport, string]>>): DatabaseAdapterMetadata {
  return { id, displayName, kind: "tool", engines, capabilities: capabilities(values) };
}

function provider(id: string, displayName: string, engines: string[], environmentVariables: string[], documentationUrl: string, branching: boolean): DatabaseAdapterMetadata {
  const inspect: [CapabilitySupport, string] = id === "neon"
    ? ["implemented", "Authenticated project metadata via the Neon API. Connection URIs are never fetched."]
    : ["planned", "Provider project and policy inspection is pending authenticated API integration."];
  const validate: [CapabilitySupport, string] = ["implemented", "Environment-contract diagnostics check required names and URL shape without printing values."];
  return {
    id, displayName, kind: "provider", engines, environmentVariables, documentationUrl,
    capabilities: capabilities({
      detect: ["implemented", "Detected from provider-specific dependencies and environment variable names; values are never read."],
      inspect,
      validate,
      provision: ["planned", "Plan-first provider API create remains pending; inspect an existing project instead."],
      "deploy-migrations": ["planned", "Migrations will be delegated to a compatible tooling adapter."],
      backup: ["planned", "Provider backup evidence and restore verification are pending."],
      ...(branching ? { branching: id === "neon" ? ["implemented", "Exact-approved branch create on an existing Neon project. Connection URIs are discarded."] as [CapabilitySupport, string] : ["planned", "Database branch lifecycle integration is pending."] as [CapabilitySupport, string] } : {}),
    }),
  };
}

export function listDatabaseAdapters(kind?: DatabaseAdapterKind): DatabaseAdapterMetadata[] {
  return adapters.filter((adapter) => !kind || adapter.kind === kind).map(cloneAdapter);
}

export function getDatabaseAdapter(id: string): DatabaseAdapterMetadata | undefined {
  const adapter = adapters.find((candidate) => candidate.id === normalizeAdapterId(id));
  return adapter ? cloneAdapter(adapter) : undefined;
}

export function resolveDatabaseStack(engineId: string, toolId?: string, providerId?: string): DatabaseAdapterMetadata[] {
  const engineAdapter = requiredAdapter(engineId, "engine");
  const selected = [engineAdapter];
  if (toolId) selected.push(requiredCompatibleAdapter(toolId, "tool", engineAdapter.id));
  if (providerId) selected.push(requiredCompatibleAdapter(providerId, "provider", engineAdapter.id));
  return selected.map(cloneAdapter);
}

export function detectDatabaseIntegrations(dependencies: Record<string, string>, environmentVariableNames: string[]): DetectedDatabaseIntegration[] {
  const dependencyNames = new Set(Object.keys(dependencies));
  const envNames = new Set(environmentVariableNames);
  const rules: Array<[string, string[], string[]]> = [
    ["prisma", ["prisma", "@prisma/client"], []],
    ["drizzle", ["drizzle-orm", "drizzle-kit"], []],
    ["typeorm", ["typeorm"], []],
    ["mikro-orm", ["@mikro-orm/core"], []],
    ["mongoose", ["mongoose"], []],
    ["supabase", ["@supabase/supabase-js"], ["SUPABASE_URL"]],
    ["neon", ["@neondatabase/serverless"], ["NEON_API_KEY", "NEON_PROJECT_ID"]],
    ["mongodb-atlas", [], ["ATLAS_PUBLIC_KEY", "ATLAS_PRIVATE_KEY"]],
    ["planetscale", ["@planetscale/database"], ["PLANETSCALE_SERVICE_TOKEN"]],
    ["upstash", ["@upstash/redis"], ["UPSTASH_REDIS_REST_URL"]],
    ["railway", [], ["RAILWAY_PROJECT_ID", "RAILWAY_TOKEN"]],
  ];
  return rules.flatMap(([adapterId, packages, variables]) => {
    const evidence: DetectionEvidence[] = [
      ...packages.filter((name) => dependencyNames.has(name)).map((name) => ({ source: "package.json", detail: `dependency ${name}` })),
      ...variables.filter((name) => envNames.has(name)).map((name) => ({ source: "environment-contract", detail: `variable ${name} is declared` })),
    ];
    if (evidence.length === 0) return [];
    const adapter = requiredAdapter(adapterId);
    return [{ adapterId, kind: adapter.kind, confidence: packages.some((name) => dependencyNames.has(name)) ? "high" : "medium", evidence }];
  });
}

function requiredCompatibleAdapter(id: string, kind: DatabaseAdapterKind, engineId: string): DatabaseAdapterMetadata {
  const adapter = requiredAdapter(id, kind);
  if (!adapter.engines.includes(engineId)) throw new Error(`${adapter.displayName} does not support the ${engineId} engine`);
  return adapter;
}

function requiredAdapter(id: string, kind?: DatabaseAdapterKind): DatabaseAdapterMetadata {
  const adapter = adapters.find((candidate) => candidate.id === normalizeAdapterId(id));
  if (!adapter) throw new Error(`Unknown database adapter: ${id}`);
  if (kind && adapter.kind !== kind) throw new Error(`${id} is a ${adapter.kind} adapter, not a ${kind} adapter`);
  return adapter;
}

function normalizeAdapterId(id: string): string {
  const normalized = id.toLowerCase();
  if (normalized === "postgres" || normalized === "postgresql") return "postgresql";
  if (normalized === "maria" || normalized === "mariadb") return "mariadb";
  if (normalized === "mongo" || normalized === "mongodb") return "mongodb";
  if (normalized === "atlas") return "mongodb-atlas";
  if (normalized === "mikroorm") return "mikro-orm";
  return normalized;
}

function cloneAdapter(adapter: DatabaseAdapterMetadata): DatabaseAdapterMetadata {
  return { ...adapter, engines: [...adapter.engines], capabilities: adapter.capabilities.map((item) => ({ ...item })), ...(adapter.environmentVariables ? { environmentVariables: [...adapter.environmentVariables] } : {}) };
}
