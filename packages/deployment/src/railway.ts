import { spawn } from "node:child_process";
import type { DeploymentHealthResult, Release, VibecoreManifest } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
import { applyHealthResult, createRelease, verifyDeploymentHealth } from "./releases.js";

export interface RailwayDeploymentPlan {
  provider: "railway";
  mode: "git" | "dockerfile";
  application: string;
  applicationPath: string;
  environment: string;
  sourceRevision: string;
  project: string;
  service: string;
  railwayEnvironment: string;
  healthUrl: string;
  requiredSecretNames: string[];
  digest: string;
}

export interface RailwayCommandRunner { run(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number; stdout: string; stderr: string }>; }
export interface RailwayDeploymentResult { release: Release; health: DeploymentHealthResult; commands: Array<{ command: string; args: string[] }>; }

export function createRailwayDeploymentPlan(manifest: VibecoreManifest, options: { application: string; environment: string; sourceRevision: string; mode: "git" | "dockerfile"; project: string; service: string; railwayEnvironment?: string; healthUrl: string }): RailwayDeploymentPlan {
  const application = manifest.applications[options.application];
  if (!application) throw new Error(`Application is not declared: ${options.application}`);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  if (!/^[a-f0-9]{7,64}$/i.test(options.sourceRevision)) throw new Error("Deployment source revision must be a Git commit SHA");
  if (options.mode === "dockerfile" && application.config?.deploymentWorkload !== "container") throw new Error("Railway Dockerfile mode requires config.deploymentWorkload: container");
  const applicationPath = safeRelativePath(application.path);
  const project = safeIdentifier(options.project, "Railway project"); const service = safeIdentifier(options.service, "Railway service"); const railwayEnvironment = safeIdentifier(options.railwayEnvironment ?? options.environment, "Railway environment"); const healthUrl = safeHealthUrl(options.healthUrl);
  const requiredSecretNames = [...new Set(["RAILWAY_TOKEN", ...Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret && (!variable.applications || variable.applications.includes(options.application))).map(([name]) => name)])].sort();
  const semantic = { provider: "railway" as const, mode: options.mode, application: options.application, applicationPath, environment: options.environment, sourceRevision: options.sourceRevision, project, service, railwayEnvironment, healthUrl, requiredSecretNames };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function executeRailwayDeploymentPlan(plan: RailwayDeploymentPlan, options: { approval: string; repositoryRoot: string; token: string; productionApproved?: boolean; runner?: RailwayCommandRunner; healthFetch?: typeof fetch; now?: Date }): Promise<RailwayDeploymentResult> {
  verifyPlan(plan, options.approval);
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production Railway deployment requires explicit production approval");
  if (!options.token || /\s/.test(options.token)) throw new Error("RAILWAY_TOKEN must be supplied through the execution boundary");
  const runner = options.runner ?? new SpawnRailwayCommandRunner(); const commands: Array<{ command: string; args: string[] }> = [];
  const run = async (command: string, args: string[], runOptions?: { cwd?: string; env?: NodeJS.ProcessEnv }) => { commands.push({ command, args }); const result = await runner.run(command, args, runOptions); if (result.exitCode !== 0) throw new Error(`${command} failed with exit code ${result.exitCode}`); return result; };
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: options.repositoryRoot })).stdout.trim();
  if (head.toLowerCase() !== plan.sourceRevision.toLowerCase()) throw new Error("Repository HEAD does not match the approved Railway source revision");
  const dirty = (await run("git", ["status", "--porcelain", "--", plan.applicationPath], { cwd: options.repositoryRoot })).stdout.trim();
  if (dirty) throw new Error("Application files changed after Railway deployment planning");
  const railwayArgs = ["up", plan.applicationPath, "--path-as-root", "--ci", "--json", "--project", plan.project, "--environment", plan.railwayEnvironment, "--service", plan.service, "--message", `vibecore ${plan.sourceRevision}`];
  await run("railway", railwayArgs, { cwd: options.repositoryRoot, env: { ...process.env, RAILWAY_TOKEN: options.token } });
  const release = createRelease({ provider: plan.provider, application: plan.application, environment: plan.environment, sourceRevision: plan.sourceRevision, digest: plan.digest, files: [], requiredSecretNames: plan.requiredSecretNames, notes: [] }, plan.mode, options.now);
  const health = await verifyDeploymentHealth(plan.healthUrl, { attempts: 6, timeoutSeconds: 20, intervalMs: 5000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
  return { release: applyHealthResult(release, health), health, commands };
}

export class SpawnRailwayCommandRunner implements RailwayCommandRunner {
  run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> { return new Promise((resolve, reject) => { const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) }); let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; }); child.once("error", reject); child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr })); }); }
}

function verifyPlan(plan: RailwayDeploymentPlan, approval: string): void { const { digest, ...semantic } = plan; if (approval !== digest) throw new Error("Railway deployment approval does not match the generated digest"); if (digestValue(semantic) !== digest) throw new Error("Railway deployment plan was modified after generation"); }
function safeIdentifier(value: string, label: string): string { if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} must be a safe name or identifier`); return value; }
function safeRelativePath(value: string): string { if (!value || value.startsWith("/") || value.includes("..") || !/^[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("Application path must be repository-relative and safe"); return value; }
function safeHealthUrl(value: string): string { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("Health URL must be HTTP(S) without embedded credentials"); url.hash = ""; return url.toString(); }
