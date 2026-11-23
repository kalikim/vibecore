import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { DeploymentHealthResult, DeploymentRollbackPlan, Release, VibecoreManifest } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
import { applyHealthResult, createRelease, recordRollback, verifyDeploymentHealth } from "./releases.js";

export interface DigitalOceanDeploymentPlan {
  provider: "digitalocean";
  mode: "app-platform";
  application: string;
  applicationPath: string;
  environment: string;
  sourceRevision: string;
  appId: string;
  repository: string;
  branch: string;
  gitRemote: string;
  healthUrl: string;
  requiredSecretNames: string[];
  digest: string;
}

export interface DigitalOceanCommandRunner { run(command: string, args: string[], options?: { cwd?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>; }
export interface DigitalOceanDeploymentResult { release: Release; health: DeploymentHealthResult; commands: Array<{ command: string; args: string[] }>; }
export interface DigitalOceanRollbackResult { failed: Release; release: Release; health: DeploymentHealthResult; }

export function createDigitalOceanDeploymentPlan(manifest: VibecoreManifest, options: { application: string; environment: string; sourceRevision: string; appId: string; repository: string; branch: string; gitRemote?: string; healthUrl: string }): DigitalOceanDeploymentPlan {
  const application = manifest.applications[options.application]; if (!application) throw new Error(`Application is not declared: ${options.application}`);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  if (!/^[a-f0-9]{40,64}$/i.test(options.sourceRevision)) throw new Error("DigitalOcean deployment requires a full Git commit SHA");
  const applicationPath = safeRelativePath(application.path); const appId = safeId(options.appId, "DigitalOcean app ID"); const repository = safeRepository(options.repository); const branch = safeBranch(options.branch); const gitRemote = safeId(options.gitRemote ?? "origin", "Git remote"); const healthUrl = safeHealthUrl(options.healthUrl);
  const requiredSecretNames = [...new Set(["DIGITALOCEAN_ACCESS_TOKEN", ...Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret && (!variable.applications || variable.applications.includes(options.application))).map(([name]) => name)])].sort();
  const semantic = { provider: "digitalocean" as const, mode: "app-platform" as const, application: options.application, applicationPath, environment: options.environment, sourceRevision: options.sourceRevision, appId, repository, branch, gitRemote, healthUrl, requiredSecretNames };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function executeDigitalOceanDeploymentPlan(plan: DigitalOceanDeploymentPlan, options: { approval: string; repositoryRoot: string; token: string; productionApproved?: boolean; runner?: DigitalOceanCommandRunner; healthFetch?: typeof fetch; now?: Date }): Promise<DigitalOceanDeploymentResult> {
  verifyPlan(plan, options.approval); if (plan.environment === "production" && !options.productionApproved) throw new Error("Production DigitalOcean deployment requires explicit production approval"); validateToken(options.token);
  const runner = options.runner ?? new SpawnDigitalOceanCommandRunner(); const commands: Array<{ command: string; args: string[] }> = [];
  const run = async (command: string, args: string[], runOptions?: { cwd?: string }) => { commands.push({ command, args }); const result = await runner.run(command, args, runOptions); if (result.exitCode !== 0) throw new Error(`${command} failed with exit code ${result.exitCode}`); return result; };
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: options.repositoryRoot })).stdout.trim(); if (head.toLowerCase() !== plan.sourceRevision.toLowerCase()) throw new Error("Repository HEAD does not match the approved DigitalOcean source revision");
  const dirty = (await run("git", ["status", "--porcelain", "--", plan.applicationPath, ".do/app.yaml"], { cwd: options.repositoryRoot })).stdout.trim(); if (dirty) throw new Error("Application or DigitalOcean configuration changed after planning");
  const remote = (await run("git", ["ls-remote", plan.gitRemote, `refs/heads/${plan.branch}`], { cwd: options.repositoryRoot })).stdout.trim().split(/\s+/)[0]; if (!remote || remote.toLowerCase() !== plan.sourceRevision.toLowerCase()) throw new Error("DigitalOcean source branch does not match the approved revision");
  const temporary = await mkdtemp(join(tmpdir(), "vibecore-doctl-")); const config = join(temporary, "config.yaml");
  try {
    await writeFile(config, `access-token: ${JSON.stringify(options.token)}\n`, { mode: 0o600, flag: "wx" });
    const appResult = await run("doctl", ["--config", config, "apps", "get", plan.appId, "--output", "json"]); verifyRemoteApp(appResult.stdout, plan);
    const deploymentResult = await run("doctl", ["--config", config, "apps", "create-deployment", plan.appId, "--wait", "--format", "ID", "--no-header"]);
    const providerReleaseId = safeId(deploymentResult.stdout.trim().split(/\s+/)[0] ?? "", "DigitalOcean deployment ID");
    const release = { ...createRelease({ provider: plan.provider, application: plan.application, environment: plan.environment, sourceRevision: plan.sourceRevision, digest: plan.digest, files: [], requiredSecretNames: plan.requiredSecretNames, notes: [] }, plan.mode, options.now), providerResourceId: plan.appId, providerReleaseId };
    const health = await verifyDeploymentHealth(plan.healthUrl, { attempts: 6, timeoutSeconds: 20, intervalMs: 5000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
    return { release: applyHealthResult(release, health), health, commands };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export interface DigitalOceanImagePlan {
  provider: "digitalocean";
  mode: "app-platform-image";
  application: string;
  applicationPath: string;
  environment: string;
  sourceRevision: string;
  appId: string;
  image: string;
  healthUrl: string;
  requiredSecretNames: string[];
  digest: string;
}

export function createDigitalOceanImagePlan(manifest: VibecoreManifest, options: {
  application: string;
  environment: string;
  sourceRevision: string;
  appId: string;
  healthUrl: string;
}): DigitalOceanImagePlan {
  const application = manifest.applications[options.application];
  if (!application) throw new Error(`Application is not declared: ${options.application}`);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  if (application.config?.deploymentWorkload !== "container") throw new Error("App Platform image mode requires config.deploymentWorkload: container");
  if (!/^[a-f0-9]{7,64}$/i.test(options.sourceRevision)) throw new Error("Deployment source revision must be a Git commit SHA");
  const image = immutableImage(application.config?.deploymentImage);
  const applicationPath = safeRelativePath(application.path);
  const appId = safeId(options.appId, "DigitalOcean app ID");
  const healthUrl = safeHealthUrl(options.healthUrl);
  const requiredSecretNames = [...new Set(["DIGITALOCEAN_ACCESS_TOKEN", ...Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret && (!variable.applications || variable.applications.includes(options.application))).map(([name]) => name)])].sort();
  const semantic = { provider: "digitalocean" as const, mode: "app-platform-image" as const, application: options.application, applicationPath, environment: options.environment, sourceRevision: options.sourceRevision, appId, image, healthUrl, requiredSecretNames };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function executeDigitalOceanImagePlan(plan: DigitalOceanImagePlan, options: {
  approval: string;
  repositoryRoot: string;
  token: string;
  productionApproved?: boolean;
  runner?: DigitalOceanCommandRunner;
  healthFetch?: typeof fetch;
  now?: Date;
}): Promise<DigitalOceanDeploymentResult> {
  verifyImagePlan(plan, options.approval);
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production DigitalOcean deployment requires explicit production approval");
  validateToken(options.token);
  const runner = options.runner ?? new SpawnDigitalOceanCommandRunner();
  const commands: Array<{ command: string; args: string[] }> = [];
  const run = async (command: string, args: string[], runOptions?: { cwd?: string }) => {
    commands.push({ command, args });
    const result = await runner.run(command, args, runOptions);
    if (result.exitCode !== 0) throw new Error(`${command} failed with exit code ${result.exitCode}`);
    return result;
  };
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: options.repositoryRoot })).stdout.trim();
  if (head.toLowerCase() !== plan.sourceRevision.toLowerCase()) throw new Error("Repository HEAD does not match the approved DigitalOcean source revision");
  const dirty = (await run("git", ["status", "--porcelain", "--", plan.applicationPath], { cwd: options.repositoryRoot })).stdout.trim();
  if (dirty) throw new Error("Application files changed after DigitalOcean image planning");
  const temporary = await mkdtemp(join(tmpdir(), "vibecore-doctl-image-"));
  const config = join(temporary, "config.yaml");
  const specPath = join(temporary, "spec.json");
  try {
    await writeFile(config, `access-token: ${JSON.stringify(options.token)}\n`, { mode: 0o600, flag: "wx" });
    const appResult = await run("doctl", ["--config", config, "apps", "get", plan.appId, "--output", "json"]);
    const spec = pinImageSpec(readAppSpec(appResult.stdout), plan.image);
    await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await run("doctl", ["--config", config, "apps", "update", plan.appId, "--spec", specPath]);
    const deploymentResult = await run("doctl", ["--config", config, "apps", "create-deployment", plan.appId, "--wait", "--format", "ID", "--no-header"]);
    const providerReleaseId = safeId(deploymentResult.stdout.trim().split(/\s+/)[0] ?? "", "DigitalOcean deployment ID");
    const release = { ...createRelease({ provider: plan.provider, application: plan.application, environment: plan.environment, sourceRevision: plan.sourceRevision, digest: plan.digest, files: [], requiredSecretNames: plan.requiredSecretNames, notes: [] }, plan.mode, options.now), providerResourceId: plan.appId, providerReleaseId };
    const health = await verifyDeploymentHealth(plan.healthUrl, { attempts: 6, timeoutSeconds: 20, intervalMs: 5000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
    return { release: applyHealthResult(release, health), health, commands };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function executeDigitalOceanRollback(plan: DeploymentRollbackPlan, releases: Release[], options: { approval: string; token: string; healthUrl: string; productionApproved?: boolean; apiFetch?: typeof fetch; healthFetch?: typeof fetch; now?: Date }): Promise<DigitalOceanRollbackResult> {
  if (plan.provider !== "digitalocean" || (plan.mode !== "app-platform" && plan.mode !== "app-platform-image") || !plan.providerResourceId || !plan.targetProviderReleaseId) throw new Error("Rollback plan lacks DigitalOcean app and deployment identifiers");
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production DigitalOcean rollback requires explicit production approval"); validateToken(options.token);
  const staged = recordRollback(releases, plan, options.approval, options.now); const request = options.apiFetch ?? fetch; const endpoint = `https://api.digitalocean.com/v2/apps/${encodeURIComponent(plan.providerResourceId)}/rollback`; const body = JSON.stringify({ deployment_id: plan.targetProviderReleaseId, skip_pin: true }); const headers = { authorization: `Bearer ${options.token}`, "content-type": "application/json" };
  const validation = await request(`${endpoint}/validate`, { method: "POST", redirect: "error", headers, body, signal: AbortSignal.timeout(30_000) }); if (!validation.ok) throw new Error(`DigitalOcean rollback validation failed with HTTP ${validation.status}`); const validationBody = await validation.json() as { valid?: boolean }; if (validationBody.valid !== true) throw new Error("DigitalOcean rejected the rollback target");
  const response = await request(endpoint, { method: "POST", redirect: "error", headers, body, signal: AbortSignal.timeout(30_000) }); if (!response.ok) throw new Error(`DigitalOcean rollback failed with HTTP ${response.status}`); const payload = await response.json() as { deployment?: { id?: string } }; const providerReleaseId = safeId(payload.deployment?.id ?? "", "DigitalOcean rollback deployment ID");
  const health = await verifyDeploymentHealth(safeHealthUrl(options.healthUrl), { attempts: 6, timeoutSeconds: 20, intervalMs: 5000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) }); const release = applyHealthResult({ ...staged.rollback, providerResourceId: plan.providerResourceId, providerReleaseId }, health);
  return { failed: staged.failed, release, health };
}

export class SpawnDigitalOceanCommandRunner implements DigitalOceanCommandRunner { run(command: string, args: string[], options: { cwd?: string } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> { return new Promise((resolve, reject) => { const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], ...(options.cwd ? { cwd: options.cwd } : {}) }); let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; }); child.once("error", reject); child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr })); }); } }

function verifyRemoteApp(source: string, plan: DigitalOceanDeploymentPlan): void { let parsed: unknown; try { parsed = JSON.parse(source); } catch { throw new Error("DigitalOcean returned invalid app JSON"); } const root = Array.isArray(parsed) ? parsed[0] : parsed; const app = object(root)?.app ?? root; const spec = object(object(app)?.spec); if (!spec) throw new Error("DigitalOcean app response has no spec"); const components = ["services", "static_sites", "workers", "jobs"].flatMap((key) => Array.isArray(spec[key]) ? spec[key] as unknown[] : []); const sources = components.map((component) => object(object(component)?.github)).filter((value): value is Record<string, unknown> => Boolean(value)); if (!sources.length) throw new Error("DigitalOcean app has no GitHub source components"); for (const source of sources) { if (source.repo !== plan.repository || source.branch !== plan.branch) throw new Error("DigitalOcean app source does not match the approved repository and branch"); if (source.deploy_on_push !== false) throw new Error("Disable DigitalOcean deploy-on-push before using exact-approved Vibecore deployments"); } }
function readAppSpec(source: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error("DigitalOcean returned invalid app JSON"); }
  const root = Array.isArray(parsed) ? parsed[0] : parsed;
  const app = object(root)?.app ?? root;
  const spec = object(object(app)?.spec) ?? object(app);
  if (!spec) throw new Error("DigitalOcean app response has no spec");
  const components = ["services", "workers", "jobs"].flatMap((key) => Array.isArray(spec[key]) ? spec[key] as unknown[] : []);
  if (!components.some((component) => object(object(component)?.image))) throw new Error("DigitalOcean app has no image-based components; use app-platform Git mode instead");
  for (const component of components) {
    const github = object(object(component)?.github);
    if (github && github.deploy_on_push !== false) throw new Error("Disable DigitalOcean deploy-on-push before using exact-approved image deployments");
  }
  return spec;
}
function pinImageSpec(spec: Record<string, unknown>, image: string): Record<string, unknown> {
  const pinned = parsePinnedImage(image);
  let count = 0;
  const next: Record<string, unknown> = { ...spec };
  for (const key of ["services", "workers", "jobs"]) {
    if (!Array.isArray(spec[key])) continue;
    next[key] = (spec[key] as unknown[]).map((component) => {
      const item = object(component);
      if (!item || !object(item.image)) return component;
      count += 1;
      const current = object(item.image) ?? {};
      return { ...item, image: { ...current, digest: pinned.digest, ...(typeof current.repository === "string" ? {} : { repository: pinned.repository }), ...(typeof current.registry === "string" ? {} : { registry: pinned.registry }) } };
    });
  }
  if (!count) throw new Error("DigitalOcean app has no image-based components; use app-platform Git mode instead");
  return next;
}
function parsePinnedImage(value: string): { registry: string; repository: string; digest: string } {
  const at = value.lastIndexOf("@sha256:");
  if (at < 1) throw new Error("App Platform image mode requires config.deploymentImage pinned with @sha256:<64 lowercase hex characters>");
  const name = value.slice(0, at);
  const digest = value.slice(at + 1);
  const slash = name.indexOf("/");
  if (slash < 1) throw new Error("Pinned image must include a registry and repository");
  return { registry: name.slice(0, slash), repository: name.slice(slash + 1), digest };
}
function immutableImage(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error("App Platform image mode requires config.deploymentImage pinned with @sha256:<64 lowercase hex characters>");
  }
  return value;
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function verifyPlan(plan: DigitalOceanDeploymentPlan, approval: string): void { const { digest, ...semantic } = plan; if (approval !== digest) throw new Error("DigitalOcean deployment approval does not match the generated digest"); if (digestValue(semantic) !== digest) throw new Error("DigitalOcean deployment plan was modified after generation"); }
function verifyImagePlan(plan: DigitalOceanImagePlan, approval: string): void { const { digest, ...semantic } = plan; if (approval !== digest) throw new Error("DigitalOcean deployment approval does not match the generated digest"); if (digestValue(semantic) !== digest) throw new Error("DigitalOcean deployment plan was modified after generation"); }
function validateToken(value: string): void { if (!value || /\s/.test(value)) throw new Error("DIGITALOCEAN_ACCESS_TOKEN must be supplied through the execution boundary"); }
function safeId(value: string, label: string): string { if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} must be a safe identifier`); return value; }
function safeRepository(value: string): string { if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value)) throw new Error("DigitalOcean repository must use owner/name format"); return value; }
function safeBranch(value: string): string { if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(value) || value.includes("..")) throw new Error("DigitalOcean branch is unsafe"); return value; }
function safeRelativePath(value: string): string { if (!value || value.startsWith("/") || value.includes("..") || !/^[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("Application path must be repository-relative and safe"); return value; }
function safeHealthUrl(value: string): string { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("Health URL must be HTTP(S) without embedded credentials"); url.hash = ""; return url.toString(); }
