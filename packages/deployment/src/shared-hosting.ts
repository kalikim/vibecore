import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { DeploymentHealthResult, DeploymentRollbackPlan, Release, VibecoreManifest } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
import { applyHealthResult, createRelease, recordRollback, verifyDeploymentHealth } from "./releases.js";
import { SpawnDeploymentCommandRunner, type DeploymentCommandRunner } from "./self-hosted.js";

export type SharedHostingMode = "static-sftp" | "php-sftp";

export interface SharedHostingPlan {
  provider: "shared-hosting";
  mode: SharedHostingMode;
  application: string;
  applicationPath: string;
  sourceDirectory: string;
  environment: string;
  sourceRevision: string;
  host: string;
  user: string;
  remoteRoot: string;
  healthUrl: string;
  requiredSecretNames: string[];
  digest: string;
}

export interface SharedHostingDeploymentResult {
  release: Release;
  health: DeploymentHealthResult;
  commands: Array<{ command: string; args: string[] }>;
}

export interface SharedHostingRollbackResult {
  failed: Release;
  release: Release;
  health: DeploymentHealthResult;
  commands: Array<{ command: string; args: string[] }>;
}

const modes = new Set<SharedHostingMode>(["static-sftp", "php-sftp"]);

export function createSharedHostingPlan(manifest: VibecoreManifest, options: {
  application: string;
  environment: string;
  sourceRevision: string;
  mode: SharedHostingMode;
  host: string;
  user: string;
  remoteRoot: string;
  healthUrl: string;
}): SharedHostingPlan {
  if (!modes.has(options.mode)) throw new Error("Shared hosting mode must be static-sftp or php-sftp");
  const application = manifest.applications[options.application];
  if (!application) throw new Error(`Application is not declared: ${options.application}`);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  validateRevision(options.sourceRevision);
  const host = safeHost(options.host);
  const user = safeUser(options.user);
  if (user === "root") throw new Error("Shared-hosting deployment refuses the root SSH user");
  const remoteRoot = safeAbsolutePath(options.remoteRoot);
  const healthUrl = safeHealthUrl(options.healthUrl);
  const applicationPath = application.path;
  const sourceDirectory = options.mode === "static-sftp"
    ? safeRelativePath(joinRelative(applicationPath, stringConfig(application.config?.outputDirectory) ?? "dist"))
    : safeRelativePath(applicationPath);
  const requiredSecretNames = Object.entries(manifest.variables ?? {})
    .filter(([, variable]) => variable.secret && (!variable.applications || variable.applications.includes(options.application)))
    .map(([name]) => name)
    .sort();
  const semantic = {
    provider: "shared-hosting" as const,
    mode: options.mode,
    application: options.application,
    applicationPath,
    sourceDirectory,
    environment: options.environment,
    sourceRevision: options.sourceRevision,
    host,
    user,
    remoteRoot,
    healthUrl,
    requiredSecretNames,
  };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function executeSharedHostingPlan(plan: SharedHostingPlan, options: {
  approval: string;
  repositoryRoot: string;
  sshKeyPath: string;
  productionApproved?: boolean;
  runner?: DeploymentCommandRunner;
  healthFetch?: typeof fetch;
  now?: Date;
}): Promise<SharedHostingDeploymentResult> {
  verifyPlan(plan, options.approval);
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production shared-hosting deployment requires explicit production approval");
  const source = await existingDirectory(options.repositoryRoot, plan.sourceDirectory);
  const keyPath = safeLocalKeyPath(options.sshKeyPath);
  const runner = options.runner ?? new SpawnDeploymentCommandRunner();
  const commands: Array<{ command: string; args: string[] }> = [];
  const invoke = createInvoker(runner, commands);
  const target = `${plan.user}@${plan.host}`;
  const ssh = sshArguments(keyPath);
  const releaseDirectory = `${plan.remoteRoot}/releases/${plan.sourceRevision}`;
  const current = `${plan.remoteRoot}/current`;
  const release = createRelease({
    provider: plan.provider, application: plan.application, environment: plan.environment, sourceRevision: plan.sourceRevision,
    digest: plan.digest, files: [], requiredSecretNames: plan.requiredSecretNames, notes: [],
  }, plan.mode, options.now);
  await refuseLiveTree(invoke, ssh, target, current);
  await invoke.run("ssh", [...ssh, target, "mkdir", "-p", releaseDirectory]);
  await invoke.run("scp", ["-r", "-B", "-q", "-i", keyPath, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "PasswordAuthentication=no", `${source}/.`, `${target}:${releaseDirectory}/`]);
  await invoke.run("ssh", [...ssh, target, "ln", "-sfn", releaseDirectory, current]);
  const health = await verifyDeploymentHealth(plan.healthUrl, { attempts: 5, timeoutSeconds: 20, intervalMs: 2000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
  return { release: applyHealthResult(release, health), health, commands };
}

export async function executeSharedHostingRollback(plan: DeploymentRollbackPlan, releases: Release[], options: {
  approval: string;
  host: string;
  user: string;
  remoteRoot: string;
  healthUrl: string;
  sshKeyPath: string;
  productionApproved?: boolean;
  runner?: DeploymentCommandRunner;
  healthFetch?: typeof fetch;
  now?: Date;
}): Promise<SharedHostingRollbackResult> {
  if (plan.provider !== "shared-hosting" || (plan.mode !== "static-sftp" && plan.mode !== "php-sftp")) throw new Error("Rollback plan is not for shared hosting");
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production shared-hosting rollback requires explicit production approval");
  const staged = recordRollback(releases, plan, options.approval, options.now);
  const host = safeHost(options.host);
  const user = safeUser(options.user);
  if (user === "root") throw new Error("Shared-hosting rollback refuses the root SSH user");
  const remoteRoot = safeAbsolutePath(options.remoteRoot);
  const healthUrl = safeHealthUrl(options.healthUrl);
  const keyPath = safeLocalKeyPath(options.sshKeyPath);
  const runner = options.runner ?? new SpawnDeploymentCommandRunner();
  const commands: Array<{ command: string; args: string[] }> = [];
  const invoke = createInvoker(runner, commands);
  const target = `${user}@${host}`;
  const ssh = sshArguments(keyPath);
  const releaseDirectory = `${remoteRoot}/releases/${plan.targetSourceRevision}`;
  const current = `${remoteRoot}/current`;
  await invoke.run("ssh", [...ssh, target, "test", "-d", releaseDirectory]);
  await refuseLiveTree(invoke, ssh, target, current);
  await invoke.run("ssh", [...ssh, target, "ln", "-sfn", releaseDirectory, current]);
  const health = await verifyDeploymentHealth(healthUrl, { attempts: 5, timeoutSeconds: 20, intervalMs: 2000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
  return { failed: staged.failed, release: applyHealthResult(staged.rollback, health), health, commands };
}

function createInvoker(runner: DeploymentCommandRunner, commands: Array<{ command: string; args: string[] }>) {
  const probe = async (command: string, args: string[]) => {
    assertSafeRemoteInvocation(command, args);
    commands.push({ command, args });
    return runner.run(command, args);
  };
  return {
    probe,
    run: async (command: string, args: string[]) => {
      const result = await probe(command, args);
      if (result.exitCode !== 0) throw new Error(`${command} failed with exit code ${result.exitCode}`);
      return result;
    },
  };
}

async function refuseLiveTree(
  invoke: { probe: (command: string, args: string[]) => Promise<{ exitCode: number }>; run: (command: string, args: string[]) => Promise<{ exitCode: number }> },
  ssh: string[],
  target: string,
  current: string,
): Promise<void> {
  const missing = await invoke.probe("ssh", [...ssh, target, "test", "!", "-e", current]);
  if (missing.exitCode === 0) return;
  const link = await invoke.probe("ssh", [...ssh, target, "test", "-L", current]);
  if (link.exitCode !== 0) throw new Error("Remote current path exists and is not a symlink; refusing to overwrite a live tree");
}

function verifyPlan(plan: SharedHostingPlan, approval: string): void {
  const { digest, ...semantic } = plan;
  if (approval !== digest) throw new Error("Shared-hosting deployment approval does not match the generated digest");
  if (digestValue(semantic) !== digest) throw new Error("Shared-hosting deployment plan was modified after generation");
}

async function existingDirectory(root: string, path: string): Promise<string> {
  const resolved = await realpath(safeRepositoryPath(root, path));
  const relation = relative(await realpath(root), resolved);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("Shared-hosting source directory escapes the repository");
  if (!(await stat(resolved)).isDirectory()) throw new Error("Shared-hosting source directory is not a directory");
  return resolved;
}

function sshArguments(key: string): string[] {
  return ["-T", "-i", key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "-o", "PasswordAuthentication=no"];
}

function assertSafeRemoteInvocation(command: string, args: string[]): void {
  const joined = `${command} ${args.join(" ")}`.toLowerCase();
  if (joined.includes("ftp://") || joined.includes("--password") || /\s-p[^\s]/.test(joined) || joined.includes("passwordauthentication=yes")) {
    throw new Error("Shared-hosting commands must not use FTP or password authentication");
  }
}

function safeHost(value: string): string {
  if (!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\])$/.test(value)) throw new Error("Deployment host must be a hostname or bracketed IPv6 address");
  return value;
}

function safeUser(value: string): string {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value)) throw new Error("SSH user must be a safe Linux account name");
  return value;
}

function safeAbsolutePath(value: string): string {
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(value) || value.includes("..") || value === "/") throw new Error("Remote root must be a constrained absolute path");
  return value.replace(/\/$/, "");
}

function safeHealthUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Health URL must be HTTP(S) without embedded credentials");
  url.hash = "";
  return url.toString();
}

function safeLocalKeyPath(value: string): string {
  if (!value.startsWith("/") || value.includes("\0")) throw new Error("SSH key path must be absolute");
  return value;
}

function safeRelativePath(value: string): string {
  const normalized = value.replace(/^\.\//, "") || ".";
  if (normalized.startsWith("/") || normalized.includes("..")) throw new Error("Shared-hosting source directory must be repository-relative");
  return normalized;
}

function safeRepositoryPath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error("Shared-hosting source directory must be repository-relative");
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Shared-hosting source directory escapes the repository");
  return target;
}

function joinRelative(base: string, extra: string): string {
  if (base === "." || base === "") return extra;
  return `${base.replace(/\/$/, "")}/${extra.replace(/^\//, "")}`;
}

function stringConfig(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.startsWith("/") || value.includes("..")) throw new Error("Deployment outputDirectory must be a safe relative path");
  return value;
}

function validateRevision(value: string): void {
  if (!/^[a-f0-9]{7,64}$/i.test(value)) throw new Error("Deployment source revision must be a Git commit SHA");
}
