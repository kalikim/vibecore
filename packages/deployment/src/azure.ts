import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { DeploymentHealthResult, DeploymentRollbackPlan, Release, VibecoreManifest } from "@codexsafari/vibecore-contracts";
import { digestValue } from "@codexsafari/vibecore-planner";
import { applyHealthResult, createRelease, recordRollback, verifyDeploymentHealth } from "./releases.js";

export type AzureDeploymentMode = "static-web-apps" | "app-service" | "container-apps";

export interface AzureDeploymentPlan {
  provider: "azure";
  mode: AzureDeploymentMode;
  application: string;
  applicationPath: string;
  environment: string;
  sourceRevision: string;
  subscriptionId: string;
  tenantId: string;
  resourceGroup: string;
  resourceName: string;
  healthUrl: string;
  requiredSecretNames: string[];
  image?: string;
  outputDirectory?: string;
  digest: string;
}

export interface AzureCommandRunner { run(command: string, args: string[], options?: { cwd?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>; }
export interface AzureDeploymentResult { release: Release; health: DeploymentHealthResult; commands: Array<{ command: string; args: string[] }>; }
export interface AzureRollbackResult { failed: Release; release: Release; health: DeploymentHealthResult; commands: Array<{ command: string; args: string[] }>; }

type AzureRun = (command: string, args: string[], options?: { cwd?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
type AzureResource = { id: string };

const azureModes = new Set<AzureDeploymentMode>(["static-web-apps", "app-service", "container-apps"]);

export function createAzureDeploymentPlan(manifest: VibecoreManifest, options: {
  application: string;
  environment: string;
  sourceRevision: string;
  mode: AzureDeploymentMode;
  subscriptionId: string;
  tenantId: string;
  resourceGroup: string;
  resourceName: string;
  healthUrl: string;
}): AzureDeploymentPlan {
  const application = manifest.applications[options.application];
  if (!application) throw new Error(`Application is not declared: ${options.application}`);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  if (!azureModes.has(options.mode)) throw new Error("Azure mode must be static-web-apps, app-service, or container-apps");
  if (!/^[a-f0-9]{40,64}$/i.test(options.sourceRevision)) throw new Error("Azure deployment requires a full Git commit SHA");
  const applicationPath = safeRelativePath(application.path);
  const subscriptionId = safeGuid(options.subscriptionId, "Azure subscription");
  const tenantId = safeGuid(options.tenantId, "Azure tenant");
  const resourceGroup = safeResourceGroup(options.resourceGroup);
  const resourceName = safeResourceName(options.resourceName, options.mode);
  const healthUrl = safeHealthUrl(options.healthUrl);
  const container = options.mode === "container-apps" || (options.mode === "app-service" && application.config?.deploymentWorkload === "container");
  if (options.mode === "container-apps" && application.config?.deploymentWorkload !== "container") throw new Error("Azure Container Apps requires config.deploymentWorkload: container");
  const image = container ? immutableImage(application.config?.deploymentImage) : undefined;
  const outputDirectory = options.mode === "static-web-apps" ? safeRelativePath(typeof application.config?.outputDirectory === "string" ? application.config.outputDirectory : "dist") : undefined;
  const requiredSecretNames = Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret && (!variable.applications || variable.applications.includes(options.application))).map(([name]) => name).sort();
  const semantic = { provider: "azure" as const, mode: options.mode, application: options.application, applicationPath, environment: options.environment, sourceRevision: options.sourceRevision, subscriptionId, tenantId, resourceGroup, resourceName, healthUrl, requiredSecretNames, ...(image ? { image } : {}), ...(outputDirectory ? { outputDirectory } : {}) };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function executeAzureDeploymentPlan(plan: AzureDeploymentPlan, options: { approval: string; repositoryRoot: string; productionApproved?: boolean; runner?: AzureCommandRunner; healthFetch?: typeof fetch; now?: Date }): Promise<AzureDeploymentResult> {
  verifyPlan(plan, options.approval);
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production Azure deployment requires explicit production approval");
  const { run, commands } = createRunner(options.runner);
  await verifyAzureIdentity(plan, run);
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: options.repositoryRoot })).stdout.trim();
  if (head.toLowerCase() !== plan.sourceRevision.toLowerCase()) throw new Error("Repository HEAD does not match the approved Azure source revision");
  const dirty = (await run("git", ["status", "--porcelain", "--", plan.applicationPath, `.vibecore/deployments/azure-${plan.mode}`], { cwd: options.repositoryRoot })).stdout.trim();
  if (dirty) throw new Error("Application or Azure configuration changed after planning");
  const resource = verifyRemoteResource((await run("az", showArguments(plan))).stdout, plan);
  const providerReleaseId = await deployAzure(plan, options.repositoryRoot, run);
  const release = { ...createRelease({ provider: plan.provider, application: plan.application, environment: plan.environment, sourceRevision: plan.sourceRevision, digest: plan.digest, files: [], requiredSecretNames: plan.requiredSecretNames, notes: [] }, plan.mode, options.now), providerResourceId: resource.id, providerReleaseId };
  const health = await verifyDeploymentHealth(plan.healthUrl, { attempts: 6, timeoutSeconds: 20, intervalMs: 5000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
  return { release: applyHealthResult(release, health), health, commands };
}

export async function executeAzureRollback(plan: DeploymentRollbackPlan, releases: Release[], options: { approval: string; repositoryRoot: string; applicationPath: string; tenantId: string; healthUrl: string; productionApproved?: boolean; runner?: AzureCommandRunner; healthFetch?: typeof fetch; now?: Date }): Promise<AzureRollbackResult> {
  if (plan.provider !== "azure" || !azureModes.has(plan.mode as AzureDeploymentMode) || !plan.providerResourceId) throw new Error("Rollback plan lacks Azure resource identifiers");
  if (plan.mode === "static-web-apps") throw new Error("Azure Static Web Apps historical rollback is unsupported; rebuild the preceding revision and deploy it as a new exact-approved plan");
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production Azure rollback requires explicit production approval");
  const staged = recordRollback(releases, plan, options.approval, options.now);
  const target = parseAzureResourceId(plan.providerResourceId, plan.mode as AzureDeploymentMode);
  const identity: Pick<AzureDeploymentPlan, "subscriptionId" | "tenantId"> = { subscriptionId: target.subscriptionId, tenantId: safeGuid(options.tenantId, "Azure tenant") };
  const { run, commands } = createRunner(options.runner);
  await verifyAzureIdentity(identity, run);
  const providerReleaseId = await rollbackAzure(plan, target, options, run);
  const health = await verifyDeploymentHealth(safeHealthUrl(options.healthUrl), { attempts: 6, timeoutSeconds: 20, intervalMs: 5000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
  const release = applyHealthResult({ ...staged.rollback, providerResourceId: plan.providerResourceId, providerReleaseId }, health);
  return { failed: staged.failed, release, health, commands };
}

export class SpawnAzureCommandRunner implements AzureCommandRunner {
  run(command: string, args: string[], options: { cwd?: string } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], ...(options.cwd ? { cwd: options.cwd } : {}) });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  }
}

function createRunner(runner?: AzureCommandRunner): { run: AzureRun; commands: Array<{ command: string; args: string[] }> } {
  const impl = runner ?? new SpawnAzureCommandRunner();
  const commands: Array<{ command: string; args: string[] }> = [];
  const run: AzureRun = async (command, args, options) => {
    assertSafeAzureInvocation(command, args);
    commands.push({ command, args });
    const result = await impl.run(command, args, options);
    if (result.exitCode !== 0) throw new Error(`${command} failed with exit code ${result.exitCode}`);
    return result;
  };
  return { run, commands };
}

async function verifyAzureIdentity(plan: Pick<AzureDeploymentPlan, "subscriptionId" | "tenantId">, run: AzureRun): Promise<void> {
  const account = parseJsonObject((await run("az", ["account", "show", "--subscription", plan.subscriptionId, "--output", "json", "--only-show-errors"])).stdout, "Azure account");
  if (account.state !== "Enabled") throw new Error("Azure subscription is not enabled");
  if (String(account.id ?? "").toLowerCase() !== plan.subscriptionId.toLowerCase()) throw new Error("Azure CLI subscription does not match the approved plan");
  if (String(account.tenantId ?? "").toLowerCase() !== plan.tenantId.toLowerCase()) throw new Error("Azure CLI tenant does not match the approved plan");
}

async function deployAzure(plan: AzureDeploymentPlan, repositoryRoot: string, run: AzureRun): Promise<string> {
  if (plan.mode === "container-apps") return deployContainerApp(plan, run);
  if (plan.mode === "static-web-apps") return deployStaticWebApp(plan, repositoryRoot, run);
  if (plan.image) {
    await run("az", ["webapp", "config", "container", "set", ...targetArguments(plan), "--container-image-name", plan.image]);
    await run("az", ["webapp", "restart", ...targetArguments(plan)]);
    return plan.image;
  }
  await verifyAppServiceBuild(plan, run);
  await deployAppServiceZip(plan, plan.sourceRevision, repositoryRoot, run);
  return plan.sourceRevision;
}

async function rollbackAzure(plan: DeploymentRollbackPlan, target: ReturnType<typeof parseAzureResourceId>, options: { repositoryRoot: string; applicationPath: string }, run: AzureRun): Promise<string> {
  const args = [...targetArguments(target)];
  if (plan.mode === "container-apps") {
    const revision = safeRevisionName(plan.targetProviderReleaseId ?? "", "Azure Container Apps revision");
    await run("az", ["containerapp", "revision", "show", ...args, "--revision", revision]);
    await run("az", ["containerapp", "ingress", "traffic", "set", ...args, "--revision-weight", `${revision}=100`]);
    return revision;
  }
  if (plan.targetProviderReleaseId && isImage(plan.targetProviderReleaseId)) {
    await run("az", ["webapp", "config", "container", "set", ...args, "--container-image-name", plan.targetProviderReleaseId]);
    await run("az", ["webapp", "restart", ...args]);
    return plan.targetProviderReleaseId;
  }
  const applicationPath = safeRelativePath(options.applicationPath);
  await deployAppServiceZip({ ...target, applicationPath, sourceRevision: plan.targetSourceRevision }, plan.targetSourceRevision, options.repositoryRoot, run);
  return plan.targetSourceRevision;
}

async function deployContainerApp(plan: AzureDeploymentPlan, run: AzureRun): Promise<string> {
  if (!plan.image) throw new Error("Azure Container Apps deployment requires a digest-pinned image");
  const suffix = `rev-${plan.sourceRevision.slice(0, 10).toLowerCase()}`;
  const updated = parseJsonObject((await run("az", ["containerapp", "update", ...targetArguments(plan), "--image", plan.image, "--revision-suffix", suffix])).stdout, "Container Apps update");
  const revision = safeRevisionName(String(nested(updated, "properties", "latestRevisionName") ?? `${plan.resourceName}--${suffix}`), "Azure Container Apps revision");
  await run("az", ["containerapp", "ingress", "traffic", "set", ...targetArguments(plan), "--revision-weight", `${revision}=100`]);
  return revision;
}

async function deployStaticWebApp(plan: AzureDeploymentPlan, repositoryRoot: string, run: AzureRun): Promise<string> {
  const outputDirectory = plan.outputDirectory ?? "dist";
  const relativeOutput = join(plan.applicationPath, outputDirectory);
  safeRepositoryPath(repositoryRoot, relativeOutput);
  try { await run("test", ["-d", relativeOutput], { cwd: repositoryRoot }); } catch { throw new Error(`Static Web Apps output '${relativeOutput}' is missing; build the approved revision before deploying`); }
  await run("swa", ["deploy", relativeOutput, "--subscription-id", plan.subscriptionId, "--resource-group", plan.resourceGroup, "--app-name", plan.resourceName, "--env", plan.environment], { cwd: repositoryRoot });
  return plan.sourceRevision;
}

async function verifyAppServiceBuild(plan: AzureDeploymentPlan, run: AzureRun): Promise<void> {
  const settings = parseJsonArray((await run("az", ["webapp", "config", "appsettings", "list", ...targetArguments(plan)])).stdout, "App Service settings");
  const remoteBuild = settings.some((setting) => object(setting)?.name === "SCM_DO_BUILD_DURING_DEPLOYMENT" && ["true", "1"].includes(String(object(setting)?.value ?? "").toLowerCase()));
  if (!remoteBuild) throw new Error("Enable SCM_DO_BUILD_DURING_DEPLOYMENT on the App Service before zip-deploying source");
}

async function deployAppServiceZip(plan: Pick<AzureDeploymentPlan, "applicationPath" | "sourceRevision" | "subscriptionId" | "resourceGroup" | "resourceName">, revision: string, repositoryRoot: string, run: AzureRun): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "vibecore-azure-"));
  const zipPath = join(temporary, "app.zip");
  const tree = plan.applicationPath === "." ? revision : `${revision}:${plan.applicationPath}`;
  try {
    await run("git", ["archive", "--format=zip", "--output", zipPath, tree], { cwd: repositoryRoot });
    await run("az", ["webapp", "deploy", ...targetArguments(plan), "--src-path", zipPath, "--type", "zip", "--async", "false", "--track-status"]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function verifyRemoteResource(source: string, plan: AzureDeploymentPlan): AzureResource {
  const resource = parseJsonObject(source, "Azure resource");
  const id = safeArmId(String(resource.id ?? ""), plan.mode);
  if (plan.mode === "container-apps") {
    const mode = String(nested(resource, "properties", "configuration", "activeRevisionsMode") ?? "");
    if (mode.toLowerCase() !== "multiple") throw new Error("Azure Container Apps must use multiple revision mode before exact-approved deployments");
  }
  if (plan.mode === "static-web-apps") {
    const repositoryUrl = nested(resource, "properties", "repositoryUrl");
    if (typeof repositoryUrl === "string" && repositoryUrl.trim()) throw new Error("Disconnect GitHub from the Static Web App before using exact-approved artifact deployments");
  }
  if (plan.mode === "app-service" && !plan.image) {
    if (resource.httpsOnly !== true) throw new Error("Azure App Service must enable HTTPS only");
    const kind = String(resource.kind ?? "");
    const linuxFx = nested(resource, "siteConfig", "linuxFxVersion") ?? nested(resource, "properties", "siteConfig", "linuxFxVersion");
    if (!kind.toLowerCase().includes("linux") && !linuxFx) throw new Error("Azure App Service zip deployment currently targets Linux apps");
    const ftps = nested(resource, "siteConfig", "ftpsState") ?? nested(resource, "properties", "siteConfig", "ftpsState");
    if (typeof ftps === "string" && ftps.toLowerCase() !== "disabled") throw new Error("Disable App Service FTPS before using exact-approved Vibecore deployments");
  }
  return { id };
}

function showArguments(plan: AzureDeploymentPlan): string[] {
  if (plan.mode === "container-apps") return ["containerapp", "show", ...targetArguments(plan)];
  if (plan.mode === "static-web-apps") return ["staticwebapp", "show", ...targetArguments(plan)];
  return ["webapp", "show", ...targetArguments(plan)];
}

function targetArguments(plan: { subscriptionId: string; resourceGroup: string; resourceName: string }): string[] {
  return ["--subscription", plan.subscriptionId, "--resource-group", plan.resourceGroup, "--name", plan.resourceName, "--output", "json", "--only-show-errors"];
}

function parseAzureResourceId(value: string, mode: AzureDeploymentMode): { subscriptionId: string; resourceGroup: string; resourceName: string } {
  const id = safeArmId(value, mode);
  const match = id.match(/^\/subscriptions\/([0-9a-f-]{36})\/resourceGroups\/([^/]+)\/providers\/Microsoft\.(?:Web|App)\/(?:sites|staticSites|containerApps)\/([^/]+)$/i);
  if (!match?.[1] || !match[2] || !match[3]) throw new Error("Azure resource ID is incomplete");
  return { subscriptionId: match[1].toLowerCase(), resourceGroup: match[2], resourceName: match[3] };
}

function safeArmId(value: string, mode: AzureDeploymentMode): string {
  const expected = mode === "container-apps" ? "Microsoft.App/containerApps" : mode === "static-web-apps" ? "Microsoft.Web/staticSites" : "Microsoft.Web/sites";
  const pattern = new RegExp(`^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/${expected.replace(".", "\\.")}/[^/]+$`, "i");
  if (!pattern.test(value) || value.includes("..")) throw new Error("Azure resource ID is unsafe or does not match the deployment mode");
  return value;
}

function verifyPlan(plan: AzureDeploymentPlan, approval: string): void {
  const { digest, ...semantic } = plan;
  if (approval !== digest) throw new Error("Azure deployment approval does not match the generated digest");
  if (digestValue(semantic) !== digest) throw new Error("Azure deployment plan was modified after generation");
}

function assertSafeAzureInvocation(command: string, args: string[]): void {
  if (command === "az" && args[0] === "login") throw new Error("Azure execution uses the current az identity and will not run az login");
  const joined = args.join(" ").toLowerCase();
  if (joined.includes("--password") || joined.includes("client-secret") || joined.includes("--deployment-token") || joined.includes("client_secret")) {
    throw new Error("Azure execution refuses client secrets, passwords, and deployment tokens in command arguments");
  }
}

function immutableImage(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/.test(value)) throw new Error("Azure container deployment requires config.deploymentImage pinned with @sha256:<64 lowercase hex characters>");
  return value;
}

function isImage(value: string): boolean { return /@sha256:[a-f0-9]{64}$/.test(value); }
function safeGuid(value: string, label: string): string { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error(`${label} must be a GUID`); return value.toLowerCase(); }
function safeResourceGroup(value: string): string { if (!/^[-\w._()]{1,90}$/.test(value) || value.includes("..")) throw new Error("Azure resource group is unsafe"); return value; }
function safeResourceName(value: string, mode: AzureDeploymentMode): string {
  if (mode === "container-apps") {
    if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(value) || value.includes("--")) throw new Error("Azure Container Apps name must be lowercase, 2-32 characters, and without consecutive hyphens");
    return value;
  }
  if (!/^[a-zA-Z][a-zA-Z0-9-]{0,58}[a-zA-Z0-9]$/.test(value)) throw new Error("Azure resource name is unsafe");
  return value;
}
function safeRevisionName(value: string, label: string): string { if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(value) || value.includes("..")) throw new Error(`${label} is unsafe`); return value; }
function safeRelativePath(value: string): string { if (!value || value.startsWith("/") || value.includes("..") || !/^[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("Application path must be repository-relative and safe"); return value; }
function safeRepositoryPath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error("Azure output path must be repository-relative");
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Azure output path escapes the repository");
  return target;
}
function safeHealthUrl(value: string): string { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Health URL must be HTTP(S) without embedded credentials"); url.hash = ""; return url.toString(); }
function parseJsonObject(source: string, label: string): Record<string, unknown> { const parsed = parseJson(source, label); const value = object(parsed); if (!value) throw new Error(`${label} JSON must be an object`); return value; }
function parseJsonArray(source: string, label: string): unknown[] { const parsed = parseJson(source, label); if (!Array.isArray(parsed)) throw new Error(`${label} JSON must be an array`); return parsed; }
function parseJson(source: string, label: string): unknown { try { return JSON.parse(source); } catch { throw new Error(`${label} JSON is invalid`); } }
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function nested(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) { current = object(current)?.[key]; if (current === undefined) return undefined; }
  return current;
}
