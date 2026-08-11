import { describe, expect, it } from "vitest";
import type { VibecoreManifest } from "@vibecore/contracts";
import { buildLocalDatabaseCompose } from "./local-runtime.js";

const manifest: VibecoreManifest = {
  apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "database-test" },
  applications: { api: { type: "api", framework: "node", path: "." } },
  resources: {
    postgres: { type: "database", provider: "postgres" },
    mysql: { type: "database", provider: "mysql" },
    maria: { type: "database", provider: "mariadb" },
    mongo: { type: "database", provider: "mongodb" },
    cache: { type: "cache", provider: "redis" },
  },
  environments: { local: { runtime: "docker-compose" } },
};

describe("local database Compose generation", () => {
  it("generates isolated persistent services for all five engines", () => {
    const result = buildLocalDatabaseCompose(manifest);
    expect(Object.keys(result.model.services)).toEqual(["postgres", "mysql", "maria", "mongo", "cache"]);
    expect(result.requiredVariables).toEqual(["MONGO_INITDB_ROOT_PASSWORD", "MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD", "POSTGRES_PASSWORD", "REDIS_PASSWORD"]);
    for (const service of Object.values(result.model.services)) {
      expect(service.ports[0]).toMatch(/^127\.0\.0\.1:/);
      expect(service.security_opt).toContain("no-new-privileges:true");
      expect(service.healthcheck.test.length).toBeGreaterThan(1);
    }
    expect(result.yaml).not.toContain("password123");
    expect(result.model.services.maria?.ports).toEqual(["127.0.0.1:3307:3306"]);
  });

  it("validates overrides and generates authenticated MongoDB replica-set setup", () => {
    const invalid = structuredClone(manifest);
    invalid.resources!.postgres!.config = { port: 80 };
    expect(() => buildLocalDatabaseCompose(invalid)).toThrow("integer port");
    const replica = structuredClone(manifest);
    replica.resources!.mongo!.config = { replicaSet: true };
    const result = buildLocalDatabaseCompose(replica);
    expect(result.requiredVariables).toContain("MONGO_REPLICA_SET_KEY");
    expect(result.model.services.mongo?.command).toContain("--keyFile");
    expect(result.yaml).toContain("rs.initiate");
  });
});
