import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { parse } from "yaml";
import type { Diagnostic, DiscoveredApiRoute } from "@vibecore/contracts";

const httpMethods = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

export async function validateOpenApiFile(repositoryRoot: string, pathInput: string, discoveredRoutes: DiscoveredApiRoute[] = []): Promise<Diagnostic[]> {
  const root = await realpath(repositoryRoot);
  const candidate = isAbsolute(pathInput) ? pathInput : resolve(root, pathInput);
  const path = await realpath(candidate);
  const relation = relative(root, path);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error(`OpenAPI path escapes the repository: ${pathInput}`);
  const source = await readFile(path, "utf8");
  let document: unknown;
  try { document = parse(source); } catch { return [diagnostic("api.docs.syntax", "error", "OpenAPI document is not valid YAML or JSON")]; }
  return validateOpenApiDocument(document, discoveredRoutes);
}

export function validateOpenApiDocument(document: unknown, discoveredRoutes: DiscoveredApiRoute[] = []): Diagnostic[] {
  if (!isRecord(document)) return [diagnostic("api.docs.document", "error", "OpenAPI document must be an object")];
  const diagnostics: Diagnostic[] = [];
  if (typeof document.openapi !== "string" || !document.openapi.startsWith("3.")) diagnostics.push(diagnostic("api.docs.version", "error", "OpenAPI version must be 3.x"));
  if (!isRecord(document.info) || typeof document.info.title !== "string" || typeof document.info.version !== "string") diagnostics.push(diagnostic("api.docs.info", "error", "OpenAPI info.title and info.version are required"));
  const paths = isRecord(document.paths) ? document.paths : undefined;
  if (!paths) { diagnostics.push(diagnostic("api.docs.paths", "error", "OpenAPI paths must be an object")); return diagnostics; }
  const globalSecurity = Array.isArray(document.security) && document.security.length > 0;
  const operationIds = new Set<string>();
  const documented = new Set<string>();
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!path.startsWith("/") || !isRecord(pathItem)) { diagnostics.push(diagnostic("api.docs.path.invalid", "error", `Invalid OpenAPI path: ${path}`)); continue; }
    for (const method of httpMethods) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      documented.add(`${method} ${path}`);
      if (typeof operation.operationId !== "string" || !operation.operationId) diagnostics.push(diagnostic("api.docs.operation_id.missing", "warning", `${method.toUpperCase()} ${path} has no operationId`));
      else if (operationIds.has(operation.operationId)) diagnostics.push(diagnostic("api.docs.operation_id.duplicate", "error", `Duplicate operationId: ${operation.operationId}`));
      else operationIds.add(operation.operationId);
      if (!hasSuccessResponse(operation.responses)) diagnostics.push(diagnostic("api.docs.response.success_missing", "warning", `${method.toUpperCase()} ${path} has no 2xx response`));
      for (const parameter of [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!)) {
        if (!hasPathParameter(operation.parameters, parameter) && !hasPathParameter(pathItem.parameters, parameter)) diagnostics.push(diagnostic("api.docs.path_parameter.missing", "error", `${method.toUpperCase()} ${path} does not declare required path parameter ${parameter}`));
      }
      const secured = globalSecurity || (Array.isArray(operation.security) && operation.security.length > 0);
      if (!secured && /^\/(admin|internal|debug|metrics)(\/|$)/i.test(path)) diagnostics.push(diagnostic("api.docs.sensitive_route.unsecured", "error", `${method.toUpperCase()} ${path} is sensitive but declares no security requirement`));
      else if (!secured && !/^\/(health|ready|live)(\/|$)/i.test(path)) diagnostics.push(diagnostic("api.docs.security.missing", "warning", `${method.toUpperCase()} ${path} declares no security requirement`));
    }
  }
  for (const route of discoveredRoutes) if (!documented.has(`${route.method} ${route.path}`)) diagnostics.push(diagnostic("api.docs.route.undocumented", "warning", `${route.method.toUpperCase()} ${route.path} exists in source but not in OpenAPI`));
  const discovered = new Set(discoveredRoutes.map((route) => `${route.method} ${route.path}`));
  for (const operation of documented) if (discoveredRoutes.length > 0 && !discovered.has(operation) && !operation.endsWith(" /health")) diagnostics.push(diagnostic("api.docs.route.stale", "warning", `${operation.toUpperCase()} is documented but was not discovered in source`));
  if (Array.isArray(document.servers)) for (const [index, server] of document.servers.entries()) {
    if (!isRecord(server) || typeof server.url !== "string") continue;
    if (/localhost|127\.0\.0\.1|0\.0\.0\.0|\.local(?=[:/]|$)|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+/i.test(server.url)) diagnostics.push(diagnostic("api.docs.server.internal", "warning", `Server ${index + 1} appears to expose a local or private address`));
    if (/^[a-z]+:\/\/[^/]*@/i.test(server.url)) diagnostics.push(diagnostic("api.docs.server.credentials", "error", `Server ${index + 1} contains embedded credentials`));
  }
  return diagnostics;
}

function hasSuccessResponse(value: unknown): boolean { return isRecord(value) && Object.keys(value).some((status) => /^2\d\d$/.test(status)); }
function hasPathParameter(value: unknown, name: string): boolean { return Array.isArray(value) && value.some((item) => isRecord(item) && item.name === name && item.in === "path" && item.required === true); }
function diagnostic(code: string, severity: Diagnostic["severity"], message: string): Diagnostic { return { code, severity, component: "api-docs", message }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
