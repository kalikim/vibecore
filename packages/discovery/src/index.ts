import { access, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  ApplicationType,
  DetectedApplication,
  DetectedResource,
  Diagnostic,
  PackageManager,
  LanguageAdapterMetadata,
  RepositoryScan,
  VibecoreManifest,
} from "@vibecore/contracts";

interface PackageDocument {
  name?: string;
  packageManager?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface FrameworkSignature {
  dependency: string;
  framework: string;
  type: ApplicationType;
}

const frameworkSignatures: FrameworkSignature[] = [
  { dependency: "next", framework: "next", type: "web" },
  { dependency: "expo", framework: "expo", type: "mobile" },
  { dependency: "hono", framework: "hono", type: "api" },
  { dependency: "@nestjs/core", framework: "nest", type: "api" },
  { dependency: "express", framework: "express", type: "api" },
  { dependency: "nuxt", framework: "nuxt", type: "web" },
  { dependency: "@remix-run/react", framework: "remix", type: "web" },
  { dependency: "vite", framework: "vite-react", type: "web" },
];

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".turbo",
  ".vibecore",
  "build",
  "coverage",
  "dist",
  "examples",
  "fixtures",
  "node_modules",
  "out",
]);

const lockfiles: Array<{ file: string; manager: PackageManager }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "package-lock.json", manager: "npm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
];

const languageAdapters: LanguageAdapterMetadata[] = [
  { id: "javascript", displayName: "JavaScript / TypeScript", packageTools: ["pnpm", "npm", "yarn", "bun"], frameworks: ["next", "expo", "hono", "nest", "express", "nuxt", "remix", "vite-react"], detectionFiles: ["package.json"], status: "implemented" },
  { id: "python", displayName: "Python", packageTools: ["uv", "pip", "poetry"], frameworks: ["fastapi", "django"], detectionFiles: ["pyproject.toml", "requirements.txt", "manage.py"], status: "implemented" },
  { id: "go", displayName: "Go", packageTools: ["go-modules"], frameworks: ["go-http", "gin"], detectionFiles: ["go.mod"], status: "implemented" },
  { id: "php", displayName: "PHP", packageTools: ["composer"], frameworks: ["laravel"], detectionFiles: ["composer.json", "artisan"], status: "implemented" },
  { id: "rust", displayName: "Rust", packageTools: ["cargo"], frameworks: ["axum"], detectionFiles: ["Cargo.toml"], status: "implemented" },
  { id: "java", displayName: "Java", packageTools: ["maven", "gradle"], frameworks: ["spring-boot"], detectionFiles: ["pom.xml", "build.gradle"], status: "implemented" },
  { id: "kotlin", displayName: "Kotlin", packageTools: ["maven", "gradle"], frameworks: ["spring-boot"], detectionFiles: ["pom.xml", "build.gradle.kts"], status: "implemented" },
  { id: "dotnet", displayName: ".NET", packageTools: ["nuget", "dotnet"], frameworks: ["aspnet-core"], detectionFiles: ["*.csproj", "*.fsproj"], status: "implemented" },
];

export function listLanguageAdapters(): LanguageAdapterMetadata[] { return languageAdapters.map((adapter) => ({ ...adapter, packageTools: [...adapter.packageTools], frameworks: [...adapter.frameworks], detectionFiles: [...adapter.detectionFiles] })); }

export async function scanRepository(repositoryRoot: string): Promise<RepositoryScan> {
  const root = resolve(repositoryRoot);
  const diagnostics: Diagnostic[] = [];
  const packageFiles = await findPackageFiles(root);
  const packageDocuments = await readPackages(packageFiles, diagnostics);
  const packageManager = await detectPackageManager(root, packageDocuments, diagnostics);
  const applications = [...detectApplications(root, packageDocuments, packageManager?.name), ...await detectNonNodeApplications(root)];
  const resources = await detectResources(root, packageDocuments);
  const fingerprint = await fingerprintInputs(root, packageFiles);

  if (applications.length === 0) {
    diagnostics.push({
      code: "discovery.application.none",
      severity: "error",
      component: "repository",
      message: "No supported application framework was detected",
    });
  }

  return {
    root,
    fingerprint,
    ...(packageManager ? { packageManager } : {}),
    applications,
    resources,
    diagnostics,
  };
}

async function fingerprintInputs(root: string, packageFiles: string[]): Promise<string> {
  const candidates = [
    ...packageFiles,
    ...await findLanguageFiles(root),
    ...lockfiles.map(({ file }) => join(root, file)),
    ...["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml", "prisma/schema.prisma"]
      .map((file) => join(root, file)),
  ];
  const hash = createHash("sha256");

  for (const file of [...new Set(candidates)].sort()) {
    try {
      const content = await readFile(file);
      hash.update(toProjectPath(root, file));
      hash.update("\0");
      hash.update(content);
      hash.update("\0");
    } catch {
      // Missing optional inputs are represented by their absence from the digest.
    }
  }

  return hash.digest("hex");
}

export function createManifestProposal(scan: RepositoryScan): VibecoreManifest {
  if (scan.applications.length === 0) {
    throw new Error("Cannot create a manifest proposal without a supported application");
  }

  const rootName = sanitizeIdentifier(basename(scan.root));
  const applications: VibecoreManifest["applications"] = {};
  const resources: NonNullable<VibecoreManifest["resources"]> = {};

  for (const application of scan.applications) {
    applications[uniqueName(application.name, applications)] = {
      type: application.type,
      framework: application.framework,
      ...(application.language ? { language: application.language } : {}),
      path: application.path,
      ...(application.commands ? { commands: application.commands } : {}),
    };
  }

  for (const resource of scan.resources) {
    resources[uniqueName(resource.name, resources)] = {
      type: resource.type,
      provider: resource.provider,
      ...(resource.config ? { config: resource.config } : {}),
    };
  }

  return {
    $schema: "https://vibecore.build/schemas/v1alpha1/vibecore.schema.json",
    apiVersion: "vibecore.dev/v1alpha1",
    kind: "Application",
    metadata: { name: rootName },
    ...(scan.packageManager
      ? { workspace: { packageManager: scan.packageManager.name } }
      : {}),
    applications,
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
    environments: {
      local: {
        runtime: scan.resources.some((resource) => resource.provider === "docker-compose")
          ? "docker-compose"
          : "local-process",
      },
    },
    policies: {
      requirePlan: true,
      requireProductionApproval: true,
      requireBackupForDestructiveMigration: true,
    },
  };
}

async function findPackageFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 6) return;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name === "package.json") {
        results.push(join(directory, entry.name));
      } else if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) {
        await visit(join(directory, entry.name), depth + 1);
      }
    }
  }

  await visit(root, 0);
  return results.sort();
}

async function readPackages(
  files: string[],
  diagnostics: Diagnostic[],
): Promise<Array<{ file: string; document: PackageDocument }>> {
  const packages: Array<{ file: string; document: PackageDocument }> = [];

  for (const file of files) {
    try {
      const document = JSON.parse(await readFile(file, "utf8")) as PackageDocument;
      packages.push({ file, document });
    } catch (error) {
      diagnostics.push({
        code: "discovery.package-json.invalid",
        severity: "error",
        component: "repository",
        message: `Unable to parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
        evidence: [{ source: file, detail: "Invalid package.json" }],
      });
    }
  }

  return packages;
}

async function detectPackageManager(
  root: string,
  packages: Array<{ file: string; document: PackageDocument }>,
  diagnostics: Diagnostic[],
): Promise<RepositoryScan["packageManager"]> {
  const rootPackage = packages.find(({ file }) => dirname(file) === root)?.document;
  const declared = parsePackageManager(rootPackage?.packageManager);
  const found: Array<{ file: string; manager: PackageManager }> = [];

  for (const lockfile of lockfiles) {
    if (await exists(join(root, lockfile.file))) found.push(lockfile);
  }

  const managers = new Set(found.map(({ manager }) => manager));
  if (managers.size > 1) {
    diagnostics.push({
      code: "discovery.package-manager.multiple-lockfiles",
      severity: "warning",
      component: "workspace",
      message: `Multiple package managers were detected: ${[...managers].join(", ")}`,
      evidence: found.map(({ file, manager }) => ({ source: file, detail: manager })),
    });
  }

  const selected = declared ?? found[0]?.manager;
  if (!selected) return undefined;

  const evidence = [
    ...(declared
      ? [{ source: "package.json#packageManager", detail: rootPackage?.packageManager ?? declared }]
      : []),
    ...found.filter(({ manager }) => manager === selected).map(({ file }) => ({ source: file, detail: selected })),
  ];

  return { name: selected, confidence: declared ? "high" : "medium", evidence };
}

function detectApplications(
  root: string,
  packages: Array<{ file: string; document: PackageDocument }>,
  packageManager: PackageManager | undefined,
): DetectedApplication[] {
  const applications: DetectedApplication[] = [];

  for (const { file, document } of packages) {
    const dependencies = { ...document.devDependencies, ...document.dependencies };
    const signature = frameworkSignatures.find(({ dependency }) => dependency in dependencies);
    const genericNodeApplication = document.bin !== undefined;
    if (!signature && !genericNodeApplication) continue;

    const packageDirectory = dirname(file);
    const applicationPath = toProjectPath(root, packageDirectory);
    const packageName = document.name?.replace(/^@[^/]+\//, "");
    const fallbackName = applicationPath === "." ? basename(root) : basename(packageDirectory);

    const commands = detectedCommands(document.scripts, packageManager);
    applications.push({
      name: sanitizeIdentifier(packageName || fallbackName),
      type: signature?.type ?? "worker",
      framework: signature?.framework ?? "node",
      language: "javascript",
      path: applicationPath,
      confidence: "high",
      evidence: [{
        source: toProjectPath(root, file),
        detail: signature ? `dependency ${signature.dependency}` : "package binary entry",
      }],
      ...(commands ? { commands } : {}),
    });
  }

  return applications;
}

async function detectNonNodeApplications(root: string): Promise<DetectedApplication[]> {
  const files = await findLanguageFiles(root);
  const applications: DetectedApplication[] = [];
  for (const file of files) {
    const name = basename(file);
    const directory = dirname(file);
    const path = toProjectPath(root, directory);
    const source = await readFile(file, "utf8");
    let language: string | undefined;
    let framework: string | undefined;
    let commands: DetectedApplication["commands"];
    if (name === "pyproject.toml" || name === "requirements.txt" || name === "manage.py") {
      language = "python"; framework = /django/i.test(source) || name === "manage.py" ? "django" : /fastapi/i.test(source) ? "fastapi" : undefined;
      if (framework === "django") commands = { dev: "python manage.py runserver", test: "python manage.py test" };
    } else if (name === "go.mod") {
      language = "go"; framework = source.includes("github.com/gin-gonic/gin") ? "gin" : "go-http";
      commands = { dev: "go run .", build: "go build ./...", test: "go test ./..." };
    } else if (name === "composer.json") {
      language = "php"; framework = source.includes("laravel/framework") ? "laravel" : undefined;
      if (framework) commands = { dev: "php artisan serve", test: "php artisan test" };
    } else if (name === "Cargo.toml") {
      language = "rust"; framework = /\baxum\b/.test(source) ? "axum" : undefined;
      if (framework) commands = { dev: "cargo run", build: "cargo build", test: "cargo test" };
    } else if (name === "pom.xml" || name.startsWith("build.gradle")) {
      const kotlin = name.endsWith(".kts") || source.includes("kotlin(");
      language = kotlin ? "kotlin" : "java"; framework = /spring-boot|org\.springframework\.boot/.test(source) ? "spring-boot" : undefined;
      if (framework) commands = name === "pom.xml" ? { dev: "mvn spring-boot:run", build: "mvn package", test: "mvn test" } : { dev: "gradle bootRun", build: "gradle build", test: "gradle test" };
    } else if (/\.(cs|fs)proj$/.test(name)) {
      language = "dotnet"; framework = /Microsoft\.NET\.Sdk\.Web/.test(source) ? "aspnet-core" : undefined;
      if (framework) commands = { dev: "dotnet run", build: "dotnet build", test: "dotnet test" };
    }
    if (!language || !framework) continue;
    applications.push({ name: sanitizeIdentifier(path === "." ? basename(root) : basename(directory)), type: "api", framework, language, path, confidence: "high", evidence: [{ source: toProjectPath(root, file), detail: `${language} ${framework} signature` }], ...(commands ? { commands } : {}) });
  }
  return deduplicateApplications(applications);
}

async function findLanguageFiles(root: string): Promise<string[]> {
  const names = new Set(["pyproject.toml", "requirements.txt", "manage.py", "go.mod", "composer.json", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts"]);
  const results: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 6) return;
    let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isFile() && (names.has(entry.name) || /\.(cs|fs)proj$/.test(entry.name))) results.push(join(directory, entry.name));
      else if (entry.isDirectory() && !ignoredDirectories.has(entry.name)) await visit(join(directory, entry.name), depth + 1);
    }
  }
  await visit(root, 0); return results.sort();
}

function deduplicateApplications(applications: DetectedApplication[]): DetectedApplication[] {
  const selected = new Map<string, DetectedApplication>();
  for (const app of applications) if (!selected.has(app.path) || app.framework !== "django") selected.set(app.path, app);
  return [...selected.values()];
}

function detectedCommands(
  scripts: Record<string, string> | undefined,
  packageManager: PackageManager | undefined,
): DetectedApplication["commands"] | undefined {
  if (!scripts) return undefined;
  const manager = packageManager ?? "npm";
  const commandFor = (name: string): string => manager === "npm" ? `npm run ${name}` : `${manager} ${name}`;
  const commands: NonNullable<DetectedApplication["commands"]> = {};
  for (const name of ["dev", "build", "test", "start"] as const) {
    if (scripts[name]) commands[name] = commandFor(name);
  }
  return Object.keys(commands).length > 0 ? commands : undefined;
}

async function detectResources(
  root: string,
  packages: Array<{ file: string; document: PackageDocument }>,
): Promise<DetectedResource[]> {
  const resources: DetectedResource[] = [];
  const prismaPackage = packages.find(({ document }) => {
    const dependencies = { ...document.devDependencies, ...document.dependencies };
    return "prisma" in dependencies || "@prisma/client" in dependencies;
  });
  const prismaSchema = join(root, "prisma", "schema.prisma");

  if (prismaPackage || (await exists(prismaSchema))) {
    resources.push({
      name: "database",
      type: "sql",
      provider: "postgres",
      confidence: prismaPackage && (await exists(prismaSchema)) ? "high" : "medium",
      evidence: [
        ...(prismaPackage
          ? [{ source: toProjectPath(root, prismaPackage.file), detail: "Prisma dependency" }]
          : []),
        ...((await exists(prismaSchema))
          ? [{ source: "prisma/schema.prisma", detail: "Prisma schema" }]
          : []),
      ],
      config: { orm: "prisma" },
    });
  }

  const composeFile = await firstExisting(root, ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]);
  if (composeFile) {
    resources.push({
      name: "local-services",
      type: "runtime",
      provider: "docker-compose",
      confidence: "high",
      evidence: [{ source: composeFile, detail: "Compose configuration" }],
    });
  }

  return resources;
}

function parsePackageManager(value: string | undefined): PackageManager | undefined {
  const name = value?.split("@")[0];
  return name === "pnpm" || name === "npm" || name === "yarn" || name === "bun" ? name : undefined;
}

function sanitizeIdentifier(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return /^[a-z]/.test(sanitized) ? sanitized : `app-${sanitized || "unknown"}`;
}

function uniqueName(value: string, existing: Record<string, unknown>): string {
  if (!(value in existing)) return value;
  let index = 2;
  while (`${value}-${index}` in existing) index += 1;
  return `${value}-${index}`;
}

function toProjectPath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  return value || ".";
}

async function firstExisting(root: string, candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await exists(join(root, candidate))) return candidate;
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
