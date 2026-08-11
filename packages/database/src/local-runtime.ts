import type { Diagnostic, ResourceManifest, VibecoreManifest } from "@vibecore/contracts";
import { stringify } from "yaml";

export interface LocalDatabaseService {
  image: string;
  restart: "unless-stopped";
  ports: string[];
  environment?: Record<string, string>;
  entrypoint?: string[];
  command?: string[];
  volumes: string[];
  healthcheck: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
    start_period: string;
  };
  security_opt: string[];
}

export interface LocalDatabaseComposeModel {
  services: Record<string, LocalDatabaseService>;
  volumes: Record<string, Record<string, never>>;
}

export interface LocalDatabaseComposeResult {
  model: LocalDatabaseComposeModel;
  yaml: string;
  diagnostics: Diagnostic[];
  requiredVariables: string[];
}

const aliases: Record<string, string> = { postgres: "postgresql", postgresql: "postgresql", mysql: "mysql", mariadb: "mariadb", mongo: "mongodb", mongodb: "mongodb", redis: "redis" };

export function buildLocalDatabaseCompose(manifest: VibecoreManifest): LocalDatabaseComposeResult {
  const services: Record<string, LocalDatabaseService> = {};
  const volumes: Record<string, Record<string, never>> = {};
  const diagnostics: Diagnostic[] = [];
  const requiredVariables = new Set<string>();
  for (const [name, resource] of Object.entries(manifest.resources ?? {})) {
    const engine = resolveEngine(resource);
    if (!engine) continue;
    if (services[name]) throw new Error(`Duplicate local database service name: ${name}`);
    const generated = buildService(name, engine, resource);
    services[name] = generated.service;
    volumes[generated.volume] = {};
    for (const variable of generated.requiredVariables) requiredVariables.add(variable);
    diagnostics.push(...generated.diagnostics);
  }
  if (Object.keys(services).length === 0) {
    diagnostics.push({ code: "database.local.none", severity: "info", component: "database", message: "No supported local database resources were declared." });
  }
  const model = { services, volumes };
  return { model, yaml: stringify(model, { lineWidth: 0 }), diagnostics, requiredVariables: [...requiredVariables].sort() };
}

function resolveEngine(resource: ResourceManifest): string | undefined {
  const configured = typeof resource.config?.engine === "string" ? resource.config.engine : undefined;
  const candidate = configured ?? resource.provider;
  return aliases[candidate.toLowerCase()];
}

function buildService(name: string, engine: string, resource: ResourceManifest): { service: LocalDatabaseService; volume: string; requiredVariables: string[]; diagnostics: Diagnostic[] } {
  const version = stringConfig(resource, "version");
  const configuredPort = numberConfig(resource, "port");
  const volume = `${safeName(name)}-data`;
  const common = {
    restart: "unless-stopped" as const,
    security_opt: ["no-new-privileges:true"],
  };
  if (engine === "postgresql") {
    return {
      service: {
        ...common, image: `postgres:${version ?? "17-alpine"}`,
        ports: [`127.0.0.1:${configuredPort ?? 5432}:5432`],
        environment: { POSTGRES_USER: "${POSTGRES_USER:-vibecore}", POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}", POSTGRES_DB: "${POSTGRES_DB:-app}" },
        volumes: [`${volume}:/var/lib/postgresql/data`],
        healthcheck: health(["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]),
      }, volume, requiredVariables: ["POSTGRES_PASSWORD"], diagnostics: [],
    };
  }
  if (engine === "mysql" || engine === "mariadb") {
    const maria = engine === "mariadb";
    return {
      service: {
        ...common, image: maria ? `mariadb:${version ?? "11.8"}` : `mysql:${version ?? "8.4"}`,
        ports: [`127.0.0.1:${configuredPort ?? (maria ? 3307 : 3306)}:3306`],
        environment: { MYSQL_ROOT_PASSWORD: "${MYSQL_ROOT_PASSWORD:?Set MYSQL_ROOT_PASSWORD}", MYSQL_DATABASE: "${MYSQL_DATABASE:-app}", MYSQL_USER: "${MYSQL_USER:-vibecore}", MYSQL_PASSWORD: "${MYSQL_PASSWORD:?Set MYSQL_PASSWORD}" },
        volumes: [`${volume}:/var/lib/mysql`],
        healthcheck: health(["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -u root -p$${MYSQL_ROOT_PASSWORD} --silent"]),
      }, volume, requiredVariables: ["MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD"], diagnostics: [],
    };
  }
  if (engine === "mongodb") {
    const replicaSet = booleanConfig(resource, "replicaSet") ?? false;
    const mongoEnvironment: Record<string, string> = {
      MONGO_INITDB_ROOT_USERNAME: "${MONGO_INITDB_ROOT_USERNAME:-vibecore}",
      MONGO_INITDB_ROOT_PASSWORD: "${MONGO_INITDB_ROOT_PASSWORD:?Set MONGO_INITDB_ROOT_PASSWORD}",
      ...(replicaSet ? { MONGO_REPLICA_SET_KEY: "${MONGO_REPLICA_SET_KEY:?Set MONGO_REPLICA_SET_KEY}" } : {}),
    };
    const mongoHealth = replicaSet
      ? "mongosh --quiet --username $${MONGO_INITDB_ROOT_USERNAME} --password $${MONGO_INITDB_ROOT_PASSWORD} --authenticationDatabase admin --eval \"try { rs.status().ok } catch (e) { rs.initiate({_id:'rs0',members:[{_id:0,host:'" + safeName(name) + ":27017'}]}).ok }\" | grep 1"
      : "mongosh --quiet --username $${MONGO_INITDB_ROOT_USERNAME} --password $${MONGO_INITDB_ROOT_PASSWORD} --authenticationDatabase admin --eval 'db.runCommand({ ping: 1 }).ok' | grep 1";
    return {
      service: {
        ...common, image: `mongo:${version ?? "8.0"}`,
        ports: [`127.0.0.1:${configuredPort ?? 27017}:27017`],
        environment: mongoEnvironment,
        ...(replicaSet ? {
          entrypoint: ["sh", "-c", "umask 077; printf '%s' \"$${MONGO_REPLICA_SET_KEY}\" > /tmp/mongo-keyfile; chown mongodb:mongodb /tmp/mongo-keyfile; exec docker-entrypoint.sh \"$$@\"", "--"],
          command: ["mongod", "--replSet", "rs0", "--keyFile", "/tmp/mongo-keyfile", "--bind_ip_all"],
        } : {}),
        volumes: [`${volume}:/data/db`],
        healthcheck: health(["CMD-SHELL", mongoHealth]),
      },
      volume,
      requiredVariables: replicaSet ? ["MONGO_INITDB_ROOT_PASSWORD", "MONGO_REPLICA_SET_KEY"] : ["MONGO_INITDB_ROOT_PASSWORD"],
      diagnostics: [],
    };
  }
  return {
    service: {
      ...common, image: `redis:${version ?? "8-alpine"}`,
      ports: [`127.0.0.1:${configuredPort ?? 6379}:6379`],
      environment: { REDIS_PASSWORD: "${REDIS_PASSWORD:?Set REDIS_PASSWORD}" },
      command: ["sh", "-c", "exec redis-server --appendonly yes --requirepass \"$${REDIS_PASSWORD}\""],
      volumes: [`${volume}:/data`],
      healthcheck: health(["CMD-SHELL", "redis-cli -a $${REDIS_PASSWORD} --no-auth-warning ping | grep PONG"]),
    }, volume, requiredVariables: ["REDIS_PASSWORD"], diagnostics: [],
  };
}

function health(test: string[]): LocalDatabaseService["healthcheck"] {
  return { test, interval: "2s", timeout: "3s", retries: 20, start_period: "5s" };
}

function safeName(name: string): string {
  const safe = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!safe || safe.startsWith("-") || safe.length > 63) throw new Error(`Invalid database resource name for Compose: ${name}`);
  return safe;
}

function stringConfig(resource: ResourceManifest, key: string): string | undefined {
  const value = resource.config?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`Database config.${key} must be a safe string`);
  return value;
}

function numberConfig(resource: ResourceManifest, key: string): number | undefined {
  const value = resource.config?.[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1024 || (value as number) > 65535) throw new Error(`Database config.${key} must be an integer port from 1024 to 65535`);
  return value as number;
}

function booleanConfig(resource: ResourceManifest, key: string): boolean | undefined {
  const value = resource.config?.[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`Database config.${key} must be a boolean`);
  return value;
}
