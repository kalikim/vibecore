import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeploymentHealthResult, DeploymentRollbackPlan, Release, VibecoreManifest } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
import { applyHealthResult, createRelease, recordRollback, verifyDeploymentHealth } from "./releases.js";

export interface VercelDeploymentPlan {
  provider: "vercel";
  mode: "git-web";
  application: string;
  applicationPath: string;
  environment: string;
  sourceRevision: string;
  orgId: string;
  projectId: string;
  healthUrl: string;
  production: boolean;
  requiredSecretNames: string[];
  digest: string;
}

export interface VercelCommandRunner {
  run(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface VercelDeploymentResult {
  release: Release;
  health: DeploymentHealthResult;
  commands: Array<{ command: string; args: string[] }>;
}

export interface VercelRollbackResult {
  failed: Release;
  release: Release;
  health: DeploymentHealthResult;
  commands: Array<{ command: string; args: string[] }>;
}

const supportedFrameworks = new Set(["next", "nuxt", "remix", "vite-react"]);

export function createVercelDeploymentPlan(manifest: VibecoreManifest, options: {
  application: string;
  environment: string;
  sourceRevision: string;
  orgId: string;
  projectId: string;
  healthUrl: string;
}): VercelDeploymentPlan {
  const application = manifest.applications[options.application];
  if (!application) throw new Error(`Application is not declared: ${options.application}`);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  if (application.type !== "web") throw new Error("The Vercel adapter currently supports web applications only");
  if (!supportedFrameworks.has(application.framework)) throw new Error(`Vercel deployment is not yet configured for ${application.framework}`);
  if (!/^[a-f0-9]{7,64}$/i.test(options.sourceRevision)) throw new Error("Deployment source revision must be a Git commit SHA");
  const applicationPath = safeRelativePath(application.path);
  const orgId = safeId(options.orgId, "Vercel org ID");
  const projectId = safeId(options.projectId, "Vercel project ID");
  const healthUrl = safeHealthUrl(options.healthUrl);
  const production = options.environment === "production";
  const requiredSecretNames = [...new Set(["VERCEL_TOKEN", ...Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret && (!variable.applications || variable.applications.includes(options.application))).map(([name]) => name)])].sort();
  const semantic = {
    provider: "vercel" as const, mode: "git-web" as const, application: options.application, applicationPath,
    environment: options.environment, sourceRevision: options.sourceRevision, orgId, projectId, healthUrl, production, requiredSecretNames,
  };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function executeVercelDeploymentPlan(plan: VercelDeploymentPlan, options: {
  approval: string;
  repositoryRoot: string;
  token: string;
  productionApproved?: boolean;
  runner?: VercelCommandRunner;
  healthFetch?: typeof fetch;
  now?: Date;
}): Promise<VercelDeploymentResult> {
  verifyPlan(plan, options.approval);
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production Vercel deployment requires explicit production approval");
  validateToken(options.token);
  const { run, commands } = createRunner(options.runner, options.token);
  const env = vercelEnv(plan, options.token);
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: options.repositoryRoot })).stdout.trim();
  if (head.toLowerCase() !== plan.sourceRevision.toLowerCase()) throw new Error("Repository HEAD does not match the approved Vercel source revision");
  const dirty = (await run("git", ["status", "--porcelain", "--", plan.applicationPath], { cwd: options.repositoryRoot })).stdout.trim();
  if (dirty) throw new Error("Application files changed after Vercel deployment planning");
  const deployArgs = ["deploy", "--yes", "--cwd", plan.applicationPath, ...(plan.production ? ["--prod"] : [])];
  const deployed = await run("vercel", deployArgs, { cwd: options.repositoryRoot, env });
  const url = deploymentUrl(`${deployed.stdout}\n${deployed.stderr}`);
  const inspected = await run("vercel", ["inspect", url, "--json"], { cwd: options.repositoryRoot, env });
  const providerReleaseId = deploymentId(inspected.stdout);
  const release = {
    ...createRelease({
      provider: plan.provider, application: plan.application, environment: plan.environment, sourceRevision: plan.sourceRevision,
      digest: plan.digest, files: [], requiredSecretNames: plan.requiredSecretNames, notes: [],
    }, plan.mode, options.now),
    providerResourceId: plan.projectId,
    providerReleaseId,
  };
  const health = await verifyDeploymentHealth(plan.healthUrl, { attempts: 6, timeoutSeconds: 20, intervalMs: 5000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
  return { release: applyHealthResult(release, health), health, commands };
}

export async function executeVercelRollback(plan: DeploymentRollbackPlan, releases: Release[], options: {
  approval: string;
  token: string;
  orgId: string;
  healthUrl: string;
  productionApproved?: boolean;
  runner?: VercelCommandRunner;
  healthFetch?: typeof fetch;
  now?: Date;
}): Promise<VercelRollbackResult> {
  if (plan.provider !== "vercel" || plan.mode !== "git-web" || !plan.targetProviderReleaseId) throw new Error("Rollback plan is not for a Vercel production deployment");
  if (plan.environment !== "production") throw new Error("Vercel instant rollback is only supported for production deployments");
  if (!options.productionApproved) throw new Error("Production Vercel rollback requires explicit production approval");
  validateToken(options.token);
  const staged = recordRollback(releases, plan, options.approval, options.now);
  const { run, commands } = createRunner(options.runner, options.token);
  const env = { ...process.env, VERCEL_TOKEN: options.token, VERCEL_ORG_ID: safeId(options.orgId, "Vercel org ID"), VERCEL_PROJECT_ID: safeId(plan.providerResourceId ?? "", "Vercel project ID") };
  await run("vercel", ["rollback", plan.targetProviderReleaseId, "--yes"], { env });
  const health = await verifyDeploymentHealth(safeHealthUrl(options.healthUrl), { attempts: 6, timeoutSeconds: 20, intervalMs: 5000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
  const release = applyHealthResult({ ...staged.rollback, ...(plan.providerResourceId ? { providerResourceId: plan.providerResourceId } : {}), providerReleaseId: plan.targetProviderReleaseId }, health);
  return { failed: staged.failed, release, health, commands };
}

export class SpawnVercelCommandRunner implements VercelCommandRunner {
  run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  }
}

export interface VercelLinkPlan {
  provider: "vercel";
  application: string;
  applicationPath: string;
  orgId: string;
  projectId: string;
  filePath: string;
  requiredSecretNames: string[];
  digest: string;
}

export function createVercelLinkPlan(manifest: VibecoreManifest, options: { application: string; orgId: string; projectId: string }): VercelLinkPlan {
  const application = manifest.applications[options.application];
  if (!application) throw new Error(`Application is not declared: ${options.application}`);
  if (application.type !== "web") throw new Error("The Vercel adapter currently supports web applications only");
  if (!supportedFrameworks.has(application.framework)) throw new Error(`Vercel deployment is not yet configured for ${application.framework}`);
  const applicationPath = safeRelativePath(application.path);
  const orgId = safeId(options.orgId, "Vercel org ID");
  const projectId = safeId(options.projectId, "Vercel project ID");
  const filePath = applicationPath === "." ? ".vercel/project.json" : `${applicationPath}/.vercel/project.json`;
  const semantic = { provider: "vercel" as const, application: options.application, applicationPath, orgId, projectId, filePath, requiredSecretNames: ["VERCEL_TOKEN"] };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function applyVercelLinkPlan(plan: VercelLinkPlan, options: {
  approval: string;
  repositoryRoot: string;
  token: string;
  request?: typeof fetch;
}): Promise<string> {
  const { digest, ...semantic } = plan;
  if (options.approval !== digest) throw new Error("Vercel link approval does not match the generated digest");
  if (digestValue(semantic) !== digest) throw new Error("Vercel link plan was modified after generation");
  validateToken(options.token);
  const target = join(options.repositoryRoot, plan.filePath);
  try {
    await access(target);
    throw new Error(`${plan.filePath} already exists; Vercel link will not overwrite it`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already exists")) throw error;
    if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
  }
  const url = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(plan.projectId)}`);
  if (plan.orgId.startsWith("team_")) url.searchParams.set("teamId", plan.orgId);
  const response = await (options.request ?? fetch)(url, {
    method: "GET",
    redirect: "error",
    headers: { accept: "application/json", authorization: `Bearer ${options.token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Vercel project inspect failed with HTTP ${response.status}`);
  const payload = await response.json() as { id?: unknown; accountId?: unknown };
  if (payload.id !== plan.projectId) throw new Error("Vercel project ID does not match the approved plan");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify({ orgId: plan.orgId, projectId: plan.projectId }, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  return plan.filePath;
}

function createRunner(runner: VercelCommandRunner | undefined, token: string) {
  const impl = runner ?? new SpawnVercelCommandRunner();
  const commands: Array<{ command: string; args: string[] }> = [];
  const run: VercelCommandRunner["run"] = async (command, args, options) => {
    const joined = `${command} ${args.join(" ")}`.toLowerCase();
    if (joined.includes("--token") || args.includes(token)) throw new Error("Vercel commands must not include the token as an argument");
    commands.push({ command, args });
    const result = await impl.run(command, args, options);
    if (result.exitCode !== 0) throw new Error(`${command} failed with exit code ${result.exitCode}`);
    return result;
  };
  return { run, commands };
}

function vercelEnv(plan: VercelDeploymentPlan, token: string): NodeJS.ProcessEnv {
  return { ...process.env, VERCEL_TOKEN: token, VERCEL_ORG_ID: plan.orgId, VERCEL_PROJECT_ID: plan.projectId };
}

function deploymentUrl(source: string): string {
  const match = source.match(/https:\/\/[a-z0-9.-]+\.vercel\.app/i);
  if (!match) throw new Error("Vercel deploy did not return a deployment URL");
  return match[0];
}

function deploymentId(source: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error("Vercel inspect returned invalid JSON"); }
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  const nested = record?.deployment && typeof record.deployment === "object" && record.deployment !== null ? record.deployment as Record<string, unknown> : undefined;
  const id = record?.id ?? record?.uid ?? nested?.id ?? nested?.uid;
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) throw new Error("Vercel inspect did not return a deployment ID");
  return id;
}

function verifyPlan(plan: VercelDeploymentPlan, approval: string): void {
  const { digest, ...semantic } = plan;
  if (approval !== digest) throw new Error("Vercel deployment approval does not match the generated digest");
  if (digestValue(semantic) !== digest) throw new Error("Vercel deployment plan was modified after generation");
}

function validateToken(value: string): void {
  if (!value || /\s/.test(value)) throw new Error("VERCEL_TOKEN must be supplied through the execution boundary");
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} must be a safe identifier`);
  return value;
}

function safeRelativePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("..") || !/^[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("Application path must be repository-relative and safe");
  return value;
}

function safeHealthUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Health URL must be HTTP(S) without embedded credentials");
  url.hash = "";
  return url.toString();
}
