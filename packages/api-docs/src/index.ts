import { createHash } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { stringify } from "yaml";
import type { ApiDocumentationAdapter, Diagnostic, OpenApiScaffold, VibecoreManifest } from "@vibecore/contracts";

const adapters: ApiDocumentationAdapter[] = [
  adapter("hono", "@hono/zod-openapi", ["@hono/zod-openapi", "@hono/swagger-ui"]),
  adapter("nest", "Nest OpenAPI decorators", ["@nestjs/swagger"]),
  adapter("express", "JSDoc/OpenAPI middleware", ["swagger-jsdoc", "swagger-ui-express"]),
  adapter("fastapi", "Framework-native OpenAPI", ["fastapi"]),
  adapter("django", "Django REST Framework schema generation", ["drf-spectacular"]),
  adapter("gin", "Swag annotations", ["github.com/swaggo/swag"]),
  adapter("laravel", "OpenAPI annotations", ["darkaonline/l5-swagger"]),
  adapter("axum", "Typed OpenAPI generation", ["utoipa", "utoipa-swagger-ui"]),
  adapter("spring-boot", "SpringDoc", ["org.springdoc:springdoc-openapi-starter-webmvc-ui"]),
  adapter("aspnet-core", "ASP.NET OpenAPI", ["Microsoft.AspNetCore.OpenApi", "Swashbuckle.AspNetCore"]),
];

function adapter(framework: string, strategy: string, packages: string[]): ApiDocumentationAdapter {
  return { framework, strategy, packages, specificationPath: "/openapi.json", uiPath: "/docs" };
}

export function listApiDocumentationAdapters(): ApiDocumentationAdapter[] {
  return adapters.map((item) => ({ ...item, packages: [...item.packages] }));
}

export function createOpenApiScaffold(manifest: VibecoreManifest, applicationName: string, output = "openapi.yaml"): OpenApiScaffold {
  const application = manifest.applications[applicationName];
  if (!application) throw new Error(`Application is not declared: ${applicationName}`);
  if (application.type !== "api") throw new Error(`${applicationName} is not an API application`);
  const docs = isRecord(application.config?.docs) ? application.config.docs : {};
  const publicProduction = docs.publicProduction === true;
  const diagnostics: Diagnostic[] = [];
  if (publicProduction) diagnostics.push({
    code: "api.docs.public_production", severity: "warning", component: applicationName,
    message: "Interactive API documentation is public in production; require authentication or disable the UI while retaining the OpenAPI document.",
  });
  const adapter = adapters.find((item) => item.framework === application.framework);
  if (!adapter) diagnostics.push({ code: "api.docs.framework_manual", severity: "warning", component: applicationName, message: `No automatic documentation adapter exists for ${application.framework}; the portable OpenAPI contract can still be generated.` });
  const healthPath = application.health?.path;
  const paths: Record<string, unknown> = {};
  if (healthPath) paths[healthPath] = { get: { operationId: "healthCheck", summary: "Service health", tags: ["Operations"], responses: { "200": { description: "Service is healthy" }, "503": { description: "Service is unavailable" } } } };
  const document: Record<string, unknown> = {
    openapi: "3.1.0",
    info: { title: `${manifest.metadata.name} ${applicationName} API`, version: "0.1.0", ...(manifest.metadata.description ? { description: manifest.metadata.description } : {}) },
    servers: [{ url: "/", description: "Current environment" }],
    paths,
    components: { securitySchemes: {} },
    tags: healthPath ? [{ name: "Operations", description: "Operational endpoints" }] : [],
  };
  const source = stringify(document, { lineWidth: 100 });
  const digest = createHash("sha256").update(JSON.stringify({ applicationName, output, document })).digest("hex");
  return { application: applicationName, path: output, digest, document, source, diagnostics };
}

export async function writeOpenApiScaffold(rootInput: string, scaffold: OpenApiScaffold, approval: string): Promise<string> {
  if (approval !== scaffold.digest) throw new Error("OpenAPI scaffold approval does not match the generated digest");
  const root = await realpath(rootInput);
  const candidate = isAbsolute(scaffold.path) ? scaffold.path : resolve(root, scaffold.path);
  const relation = relative(root, candidate);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`OpenAPI output escapes the repository: ${scaffold.path}`);
  await mkdir(dirname(candidate), { recursive: true });
  await writeFile(candidate, scaffold.source, { flag: "wx", mode: 0o644 });
  return relation;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
