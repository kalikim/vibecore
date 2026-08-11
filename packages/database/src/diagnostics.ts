import type { DatabaseStackDiagnosticResult, Diagnostic } from "@vibecore/contracts";
import { getDatabaseAdapter, resolveDatabaseStack } from "./registry.js";

interface VariableRule {
  names: string[];
  required: boolean;
  purpose: string;
}

const providerRules: Record<string, VariableRule[]> = {
  supabase: [
    { names: ["SUPABASE_URL"], required: true, purpose: "Supabase project API endpoint" },
    { names: ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"], required: true, purpose: "Supabase API authentication" },
    { names: ["DATABASE_URL"], required: false, purpose: "direct PostgreSQL migrations" },
  ],
  neon: [
    { names: ["DATABASE_URL"], required: true, purpose: "Neon PostgreSQL connection" },
    { names: ["NEON_API_KEY"], required: false, purpose: "Neon control-plane operations" },
    { names: ["NEON_PROJECT_ID"], required: false, purpose: "Neon project selection" },
  ],
  "mongodb-atlas": [
    { names: ["MONGODB_URI", "DATABASE_URL"], required: true, purpose: "MongoDB Atlas connection" },
    { names: ["ATLAS_PUBLIC_KEY"], required: false, purpose: "Atlas control-plane operations" },
    { names: ["ATLAS_PRIVATE_KEY"], required: false, purpose: "Atlas control-plane operations" },
  ],
  planetscale: [
    { names: ["DATABASE_URL"], required: true, purpose: "PlanetScale database connection" },
    { names: ["PLANETSCALE_SERVICE_TOKEN"], required: false, purpose: "PlanetScale control-plane operations" },
  ],
  upstash: [
    { names: ["UPSTASH_REDIS_REST_URL"], required: true, purpose: "Upstash Redis REST endpoint" },
    { names: ["UPSTASH_REDIS_REST_TOKEN"], required: true, purpose: "Upstash Redis REST authentication" },
  ],
  railway: [
    { names: ["DATABASE_URL", "MONGODB_URI", "REDIS_URL"], required: true, purpose: "Railway database connection" },
    { names: ["RAILWAY_TOKEN"], required: false, purpose: "Railway control-plane operations" },
    { names: ["RAILWAY_PROJECT_ID"], required: false, purpose: "Railway project selection" },
  ],
};

export function diagnoseDatabaseStack(
  engine: string,
  tool?: string,
  provider?: string,
  environment: NodeJS.ProcessEnv = process.env,
): DatabaseStackDiagnosticResult {
  const diagnostics: Diagnostic[] = [];
  let stack;
  try {
    stack = resolveDatabaseStack(engine, tool, provider);
    diagnostics.push({
      code: "database.stack.compatible",
      severity: "info",
      component: "database",
      message: `Compatible database stack: ${stack.map(({ displayName }) => displayName).join(" + ")}`,
    });
  } catch (error) {
    diagnostics.push({
      code: "database.stack.incompatible",
      severity: "error",
      component: "database",
      message: error instanceof Error ? error.message : String(error),
    });
    return result(engine, tool, provider, diagnostics);
  }

  if (engine === "mongodb" && tool === "prisma") {
    diagnostics.push({
      code: "database.mongodb.prisma_migrate_unavailable",
      severity: "warning",
      component: "mongodb",
      message: "Prisma validates MongoDB schemas but does not provide Prisma Migrate for MongoDB; index and data changes need a MongoDB-native workflow.",
    });
  }
  if (engine === "mongodb" && !tool) {
    diagnostics.push({
      code: "database.mongodb.tool_missing",
      severity: "warning",
      component: "mongodb",
      message: "Declare Mongoose, Prisma, TypeORM, or MikroORM so Vibecore can select an explicit MongoDB schema workflow.",
    });
  }
  if (engine === "redis" && tool) {
    diagnostics.push({
      code: "database.redis.schema_tool_unnecessary",
      severity: "warning",
      component: "redis",
      message: "Redis does not use the registered relational or document schema tooling adapters.",
    });
  }

  if (provider) diagnostics.push(...diagnoseProviderConfiguration(provider, environment));
  return result(engine, tool, provider, diagnostics);
}

export function diagnoseProviderConfiguration(providerId: string, environment: NodeJS.ProcessEnv): Diagnostic[] {
  const adapter = getDatabaseAdapter(providerId);
  if (!adapter || adapter.kind !== "provider") {
    return [{ code: "database.provider.unknown", severity: "error", component: providerId, message: `Unknown database provider adapter: ${providerId}` }];
  }
  const rules = providerRules[adapter.id] ?? [];
  const diagnostics: Diagnostic[] = [];
  for (const rule of rules) {
    const available = rule.names.filter((name) => hasValue(environment[name]));
    if (available.length > 0) {
      diagnostics.push({
        code: "database.provider.variable_available",
        severity: "info",
        component: adapter.id,
        message: `${rule.purpose} configuration is available`,
        evidence: available.map((name) => ({ source: "process environment", detail: `${name} value redacted` })),
      });
    } else {
      diagnostics.push({
        code: rule.required ? "database.provider.variable_missing" : "database.provider.optional_variable_missing",
        severity: rule.required ? "error" : "info",
        component: adapter.id,
        message: `${rule.purpose} requires ${formatAlternatives(rule.names)}`,
      });
    }
  }
  diagnostics.push(...validateConnectionShape(adapter.id, environment));
  diagnostics.push(...validateCredentialPairs(adapter.id, environment));
  return diagnostics;
}

function validateConnectionShape(providerId: string, environment: NodeJS.ProcessEnv): Diagnostic[] {
  const candidates: Array<[string, string[]]> = providerId === "supabase"
    ? [["SUPABASE_URL", ["https:"]]]
    : providerId === "upstash"
      ? [["UPSTASH_REDIS_REST_URL", ["https:"]]]
      : providerId === "mongodb-atlas"
        ? [[hasValue(environment.MONGODB_URI) ? "MONGODB_URI" : "DATABASE_URL", ["mongodb:", "mongodb+srv:"]]]
        : providerId === "railway"
          ? []
          : [["DATABASE_URL", ["postgres:", "postgresql:", "mysql:"]]];
  const diagnostics: Diagnostic[] = [];
  for (const [name, protocols] of candidates) {
    const value = environment[name];
    if (!hasValue(value)) continue;
    let protocol: string;
    try { protocol = new URL(value).protocol; } catch {
      diagnostics.push({ code: "database.provider.url_invalid", severity: "error", component: providerId, message: `${name} is not a valid connection URL; value redacted` });
      continue;
    }
    if (!protocols.includes(protocol)) {
      diagnostics.push({ code: "database.provider.url_protocol", severity: "error", component: providerId, message: `${name} uses an unexpected protocol; expected ${protocols.join(" or ")}` });
      continue;
    }
    if (providerId === "mongodb-atlas" && protocol !== "mongodb+srv:") {
      diagnostics.push({ code: "database.mongodb_atlas.srv_recommended", severity: "warning", component: providerId, message: "MongoDB Atlas connections should normally use mongodb+srv for topology discovery and TLS defaults." });
    }
  }
  return diagnostics;
}

function validateCredentialPairs(providerId: string, environment: NodeJS.ProcessEnv): Diagnostic[] {
  const pairs: Array<[string, string]> = providerId === "mongodb-atlas"
    ? [["ATLAS_PUBLIC_KEY", "ATLAS_PRIVATE_KEY"]]
    : providerId === "neon"
      ? [["NEON_API_KEY", "NEON_PROJECT_ID"]]
      : providerId === "railway"
        ? [["RAILWAY_TOKEN", "RAILWAY_PROJECT_ID"]]
        : [];
  return pairs.flatMap(([first, second]) => {
    if (hasValue(environment[first]) === hasValue(environment[second])) return [];
    return [{
      code: "database.provider.credential_pair_incomplete",
      severity: "warning" as const,
      component: providerId,
      message: `${first} and ${second} must be configured together for control-plane operations`,
    }];
  });
}

function result(engine: string, tool: string | undefined, provider: string | undefined, diagnostics: Diagnostic[]): DatabaseStackDiagnosticResult {
  return { engine, ...(tool ? { tool } : {}), ...(provider ? { provider } : {}), diagnostics };
}

function hasValue(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

function formatAlternatives(names: string[]): string {
  return names.length === 1 ? names[0]! : `one of ${names.join(", ")}`;
}
