import { readFile, readdir, realpath } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import type { DetectedApplication, Diagnostic, DiscoveredApiRoute } from "@vibecore/contracts";

const ignored = new Set([".git", ".next", ".vibecore", "build", "dist", "node_modules", "target", "vendor", "bin", "obj"]);
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".php", ".rs", ".java", ".kt", ".cs", ".fs"]);
const methods = "get|post|put|patch|delete|options|head";

export async function discoverApiRoutes(repositoryRoot: string, application: Pick<DetectedApplication, "path" | "framework">): Promise<{ routes: DiscoveredApiRoute[]; diagnostics: Diagnostic[] }> {
  const root = await realpath(repositoryRoot);
  const appRoot = resolve(root, application.path);
  const relation = relative(root, appRoot);
  if (relation.startsWith("..")) throw new Error(`Application path escapes the repository: ${application.path}`);
  const files = await sourceFiles(appRoot);
  const routes: DiscoveredApiRoute[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const evidenceSource = relative(root, file);
    routes.push(...extractRoutes(application.framework, source, evidenceSource));
  }
  const unique = new Map<string, DiscoveredApiRoute>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    const existing = unique.get(key);
    if (existing) existing.evidence.push(...route.evidence);
    else unique.set(key, route);
  }
  if (unique.size === 0) diagnostics.push({ code: "api.docs.routes.none", severity: "warning", component: application.framework, message: "No literal API routes were discovered; add routes manually or verify the framework adapter." });
  for (const route of unique.values()) if (route.requiresReview) diagnostics.push({ code: "api.docs.route.review", severity: "warning", component: route.path, message: `${route.method.toUpperCase()} ${route.path} was inferred with limited method information and requires review.` });
  return { routes: [...unique.values()].sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`)), diagnostics };
}

function extractRoutes(framework: string, source: string, file: string): DiscoveredApiRoute[] {
  const patterns: RegExp[] = [];
  if (["hono", "express"].includes(framework)) patterns.push(new RegExp(`\\b(?:app|router)\\.(${methods})\\(\\s*["']([^"']+)["']`, "gi"));
  if (framework === "fastapi") patterns.push(new RegExp(`@(?:app|router)\\.(${methods})\\(\\s*["']([^"']+)["']`, "gi"));
  if (framework === "gin") patterns.push(new RegExp(`\\.(${methods})\\(\\s*["'\x60]([^"'\x60]+)["'\x60]`, "gi"));
  if (framework === "laravel") patterns.push(new RegExp(`Route::(${methods})\\(\\s*["']([^"']+)["']`, "gi"));
  if (framework === "axum") patterns.push(new RegExp(`\\.route\\(\\s*["']([^"']+)["']\\s*,\\s*(${methods})\\(`, "gi"));
  if (framework === "aspnet-core") patterns.push(new RegExp(`\\.Map(${methods})\\(\\s*["']([^"']+)["']`, "gi"));
  if (framework === "spring-boot") patterns.push(/@(Get|Post|Put|Patch|Delete|Request)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi);
  const routes: DiscoveredApiRoute[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const axum = framework === "axum";
      const methodValue = (axum ? match[2] : match[1])?.toLowerCase();
      const rawPath = axum ? match[1] : match[2];
      if (!rawPath || !methodValue) continue;
      const method = methodValue === "request" ? "get" : methodValue;
      if (!isMethod(method)) continue;
      routes.push(route(method, normalizePath(rawPath), framework, file, methodValue === "request"));
    }
  }
  if (framework === "django") {
    for (const match of source.matchAll(/\bpath\(\s*["']([^"']+)["']/g)) routes.push(route("get", normalizePath(match[1] ?? ""), framework, file, true));
  }
  return routes;
}

function route(method: DiscoveredApiRoute["method"], path: string, framework: string, file: string, requiresReview = false): DiscoveredApiRoute {
  return { method, path, framework, confidence: requiresReview ? "low" : "high", evidence: [{ source: file, detail: `literal ${method.toUpperCase()} route` }], ...(requiresReview ? { requiresReview: true } : {}) };
}

function normalizePath(value: string): string {
  const path = `/${value}`.replace(/\/+/g, "/").replace(/<(?:(?:int|str|uuid):)?([A-Za-z_]\w*)>/g, "{$1}").replace(/:([A-Za-z_]\w*)/g, "{$1}");
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

function isMethod(value: string): value is DiscoveredApiRoute["method"] { return ["get", "post", "put", "patch", "delete", "options", "head"].includes(value); }

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(join(directory, entry.name), depth + 1);
      else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) files.push(join(directory, entry.name));
    }
  }
  await visit(root, 0); return files.sort();
}
