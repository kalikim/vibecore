import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { DeploymentHealthResult, DeploymentRollbackPlan, Release, VibecoreManifest } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
import { applyHealthResult, createRelease, recordRollback, verifyDeploymentHealth } from "./releases.js";

export interface SelfHostedDockerPlan {
  provider: "self-hosted";
  mode: "docker-compose";
  application: string;
  environment: string;
  sourceRevision: string;
  image: string;
  host: string;
  user: string;
  remoteRoot: string;
  remoteEnvironmentFile: string;
  healthUrl: string;
  compose: string;
  requiredSecretNames: string[];
  digest: string;
}

export interface DeploymentCommandRunner {
  run(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface SelfHostedDeploymentResult { release: Release; health: DeploymentHealthResult; commands: Array<{ command: string; args: string[] }>; }
export interface SelfHostedRollbackResult { failed: Release; release: Release; health: DeploymentHealthResult; commands: Array<{ command: string; args: string[] }>; }

export function createSelfHostedDockerPlan(manifest: VibecoreManifest, options: { application: string; environment: string; sourceRevision: string; host: string; user: string; remoteRoot?: string; healthUrl: string }): SelfHostedDockerPlan {
  const application = manifest.applications[options.application];
  if (!application) throw new Error(`Application is not declared: ${options.application}`);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  validateRevision(options.sourceRevision);
  const image = immutableImage(application.config?.deploymentImage);
  const host = safeHost(options.host);
  const user = safeUser(options.user);
  if (user === "root") throw new Error("Self-hosted deployment refuses the root SSH user");
  const remoteRoot = safeAbsolutePath(options.remoteRoot ?? `/opt/vibecore/${safeSegment(manifest.metadata.name, "project name")}`);
  const healthUrl = safeHealthUrl(options.healthUrl);
  const remoteEnvironmentFile = `${remoteRoot}/environments/${safeSegment(options.environment, "environment")}.env`;
  const requiredSecretNames = Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret && (!variable.applications || variable.applications.includes(options.application))).map(([name]) => name).sort();
  const port = integer(application.config?.port ?? 3000, "application port", 1, 65535);
  const hostPort = integer(application.config?.hostPort ?? port, "host port", 1024, 65535);
  const compose = `services:\n  app:\n    image: ${image}\n    pull_policy: always\n    restart: unless-stopped\n    init: true\n    read_only: true\n    security_opt:\n      - no-new-privileges:true\n    cap_drop:\n      - ALL\n    tmpfs:\n      - /tmp:rw,noexec,nosuid,size=64m\n    env_file:\n      - ${remoteEnvironmentFile}\n    ports:\n      - "127.0.0.1:${hostPort}:${port}"\n`;
  const semantic = { provider: "self-hosted" as const, mode: "docker-compose" as const, application: options.application, environment: options.environment, sourceRevision: options.sourceRevision, image, host, user, remoteRoot, remoteEnvironmentFile, healthUrl, compose, requiredSecretNames };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function executeSelfHostedDockerPlan(plan: SelfHostedDockerPlan, options: { approval: string; sshKeyPath: string; productionApproved?: boolean; runner?: DeploymentCommandRunner; healthFetch?: typeof fetch; now?: Date }): Promise<SelfHostedDeploymentResult> {
  verifyPlan(plan, options.approval);
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production self-hosted deployment requires explicit production approval");
  const keyPath = safeLocalKeyPath(options.sshKeyPath);
  const runner = options.runner ?? new SpawnDeploymentCommandRunner();
  const releaseDirectory = `${plan.remoteRoot}/releases/${plan.sourceRevision}`;
  const target = `${plan.user}@${plan.host}`;
  const project = safeSegment(`${plan.application}-${plan.environment}`, "Compose project");
  const commands: Array<{ command: string; args: string[] }> = [];
  const run = async (command: string, args: string[]) => { commands.push({ command, args }); const result = await runner.run(command, args); if (result.exitCode !== 0) throw new Error(`${command} failed with exit code ${result.exitCode}`); };
  const ssh = sshArguments(keyPath, target);
  const temporary = await mkdtemp(join(tmpdir(), "vibecore-deploy-"));
  const composePath = join(temporary, "compose.yaml");
  const release = createRelease({ provider: plan.provider, application: plan.application, environment: plan.environment, sourceRevision: plan.sourceRevision, digest: plan.digest, files: [], requiredSecretNames: plan.requiredSecretNames, notes: [] }, plan.mode, options.now);
  try {
    await writeFile(composePath, plan.compose, { mode: 0o600, flag: "wx" });
    await run("ssh", [...ssh, target, "docker", "compose", "version"]);
    await run("ssh", [...ssh, target, "test", "-f", plan.remoteEnvironmentFile]);
    await run("ssh", [...ssh, target, "mkdir", "-p", releaseDirectory]);
    await run("scp", ["-B", "-q", "-i", keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", composePath, `${target}:${releaseDirectory}/compose.yaml`]);
    const composeArgs = ["docker", "compose", "--project-name", project, "--env-file", plan.remoteEnvironmentFile, "--file", `${releaseDirectory}/compose.yaml`];
    await run("ssh", [...ssh, target, ...composeArgs, "pull", "--policy", "always"]);
    await run("ssh", [...ssh, target, ...composeArgs, "up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "120"]);
    const health = await verifyDeploymentHealth(plan.healthUrl, { attempts: 5, timeoutSeconds: 20, intervalMs: 2000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
    const checked = applyHealthResult(release, health);
    if (health.status === "healthy") await run("ssh", [...ssh, target, "ln", "-sfn", releaseDirectory, `${plan.remoteRoot}/current`]);
    return { release: checked, health, commands };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function executeSelfHostedRollback(plan: DeploymentRollbackPlan, releases: Release[], options: { approval: string; host: string; user: string; remoteRoot: string; healthUrl: string; sshKeyPath: string; productionApproved?: boolean; runner?: DeploymentCommandRunner; healthFetch?: typeof fetch; now?: Date }): Promise<SelfHostedRollbackResult> {
  if (plan.provider !== "self-hosted" || plan.mode !== "docker-compose") throw new Error("Rollback plan is not for self-hosted Docker");
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production self-hosted rollback requires explicit production approval");
  const staged = recordRollback(releases, plan, options.approval, options.now);
  const host = safeHost(options.host); const user = safeUser(options.user); if (user === "root") throw new Error("Self-hosted rollback refuses the root SSH user");
  const remoteRoot = safeAbsolutePath(options.remoteRoot); const healthUrl = safeHealthUrl(options.healthUrl); const keyPath = safeLocalKeyPath(options.sshKeyPath);
  const target = `${user}@${host}`; const releaseDirectory = `${remoteRoot}/releases/${plan.targetSourceRevision}`; const environmentFile = `${remoteRoot}/environments/${safeSegment(plan.environment, "environment")}.env`; const project = safeSegment(`${plan.application}-${plan.environment}`, "Compose project");
  const runner = options.runner ?? new SpawnDeploymentCommandRunner(); const commands: Array<{ command: string; args: string[] }> = [];
  const run = async (command: string, args: string[]) => { commands.push({ command, args }); const result = await runner.run(command, args); if (result.exitCode !== 0) throw new Error(`${command} failed with exit code ${result.exitCode}`); };
  const ssh = sshArguments(keyPath, target); const composeArgs = ["docker", "compose", "--project-name", project, "--env-file", environmentFile, "--file", `${releaseDirectory}/compose.yaml`];
  await run("ssh", [...ssh, target, "test", "-f", `${releaseDirectory}/compose.yaml`]);
  await run("ssh", [...ssh, target, ...composeArgs, "pull", "--policy", "always"]);
  await run("ssh", [...ssh, target, ...composeArgs, "up", "-d", "--remove-orphans", "--wait", "--wait-timeout", "120"]);
  const health = await verifyDeploymentHealth(healthUrl, { attempts: 5, timeoutSeconds: 20, intervalMs: 2000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
  const release = applyHealthResult(staged.rollback, health);
  if (health.status === "healthy") await run("ssh", [...ssh, target, "ln", "-sfn", releaseDirectory, `${remoteRoot}/current`]);
  return { failed: staged.failed, release, health, commands };
}

export class SpawnDeploymentCommandRunner implements DeploymentCommandRunner {
  run(command: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => { const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8"); child.stdout.on("data", (chunk: string) => { stdout += chunk; }); child.stderr.on("data", (chunk: string) => { stderr += chunk; }); child.once("error", reject); child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr })); });
  }
}

function verifyPlan(plan: SelfHostedDockerPlan, approval: string): void { const { digest, ...semantic } = plan; if (approval !== digest) throw new Error("Self-hosted deployment approval does not match the generated digest"); if (digestValue(semantic) !== digest) throw new Error("Self-hosted deployment plan was modified after generation"); }
function sshArguments(key: string, target: string): string[] { void target; return ["-T", "-i", key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "PasswordAuthentication=no"]; }
function immutableImage(value: unknown): string { if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/.test(value)) throw new Error("Self-hosted Docker requires config.deploymentImage pinned with @sha256:<64 lowercase hex characters>"); return value; }
function safeHost(value: string): string { if (!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\])$/.test(value)) throw new Error("Deployment host must be a hostname or bracketed IPv6 address"); return value; }
function safeUser(value: string): string { if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value)) throw new Error("SSH user must be a safe Linux account name"); return value; }
function safeSegment(value: string, label: string): string { const normalized = value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, ""); if (!normalized || normalized.length > 63) throw new Error(`${label} is not safe`); return normalized; }
function safeAbsolutePath(value: string): string { if (!/^\/[a-zA-Z0-9._/-]+$/.test(value) || value.includes("..") || value === "/") throw new Error("Remote root must be a constrained absolute path"); return value.replace(/\/$/, ""); }
function safeHealthUrl(value: string): string { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("Health URL must be HTTP(S) without embedded credentials"); url.hash = ""; return url.toString(); }
function safeLocalKeyPath(value: string): string { if (!value.startsWith("/") || value.includes("\0")) throw new Error("SSH key path must be absolute"); return value; }
function validateRevision(value: string): void { if (!/^[a-f0-9]{7,64}$/i.test(value)) throw new Error("Deployment source revision must be a Git commit SHA"); }
function integer(value: unknown, label: string, minimum: number, maximum: number): number { if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`); return value as number; }
