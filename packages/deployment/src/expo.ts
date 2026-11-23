import { spawn } from "node:child_process";
import type { Release, VibecoreManifest } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
import { createRelease } from "./releases.js";

export type ExpoEasOperation = "build" | "update" | "submit";
export type ExpoPlatform = "ios" | "android" | "all";

export interface ExpoEasPlan {
  provider: "expo";
  mode: "eas-build" | "eas-update" | "eas-submit";
  operation: ExpoEasOperation;
  application: string;
  applicationPath: string;
  environment: string;
  sourceRevision: string;
  profile?: string;
  platform?: ExpoPlatform;
  channel?: string;
  requiredSecretNames: string[];
  digest: string;
}

export interface ExpoCommandRunner {
  run(command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface ExpoEasResult {
  release: Release;
  output: string;
  commands: Array<{ command: string; args: string[] }>;
}

export function createExpoBuildPlan(manifest: VibecoreManifest, options: {
  application: string;
  environment: string;
  sourceRevision: string;
  profile: string;
  platform?: ExpoPlatform;
}): ExpoEasPlan {
  const application = requireExpoApp(manifest, options.application);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  validateRevision(options.sourceRevision);
  const profile = safeId(options.profile, "EAS profile");
  const platform = options.platform ?? "all";
  if (platform !== "ios" && platform !== "android" && platform !== "all") throw new Error("EAS platform must be ios, android, or all");
  const requiredSecretNames = ["EXPO_TOKEN"];
  const semantic = {
    provider: "expo" as const, mode: "eas-build" as const, operation: "build" as const,
    application: options.application, applicationPath: safeRelativePath(application.path), environment: options.environment,
    sourceRevision: options.sourceRevision, profile, platform, requiredSecretNames,
  };
  return { ...semantic, digest: digestValue(semantic) };
}

export function createExpoUpdatePlan(manifest: VibecoreManifest, options: {
  application: string;
  environment: string;
  sourceRevision: string;
  channel: string;
}): ExpoEasPlan {
  const application = requireExpoApp(manifest, options.application);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  validateRevision(options.sourceRevision);
  const channel = safeId(options.channel, "EAS channel");
  const requiredSecretNames = ["EXPO_TOKEN"];
  const semantic = {
    provider: "expo" as const, mode: "eas-update" as const, operation: "update" as const,
    application: options.application, applicationPath: safeRelativePath(application.path), environment: options.environment,
    sourceRevision: options.sourceRevision, channel, requiredSecretNames,
  };
  return { ...semantic, digest: digestValue(semantic) };
}

export function createExpoSubmitPlan(manifest: VibecoreManifest, options: {
  application: string;
  environment: string;
  sourceRevision: string;
  profile: string;
  platform: Exclude<ExpoPlatform, "all">;
}): ExpoEasPlan {
  const application = requireExpoApp(manifest, options.application);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  validateRevision(options.sourceRevision);
  if (options.platform !== "ios" && options.platform !== "android") throw new Error("EAS submit requires ios or android");
  const profile = safeId(options.profile, "EAS profile");
  const requiredSecretNames = ["EXPO_TOKEN"];
  const semantic = {
    provider: "expo" as const, mode: "eas-submit" as const, operation: "submit" as const,
    application: options.application, applicationPath: safeRelativePath(application.path), environment: options.environment,
    sourceRevision: options.sourceRevision, profile, platform: options.platform, requiredSecretNames,
  };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function executeExpoEasPlan(plan: ExpoEasPlan, options: {
  approval: string;
  repositoryRoot: string;
  token: string;
  productionApproved?: boolean;
  runner?: ExpoCommandRunner;
  now?: Date;
}): Promise<ExpoEasResult> {
  verifyPlan(plan, options.approval);
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production Expo operations require explicit production approval");
  if (!options.token || /\s/.test(options.token)) throw new Error("EXPO_TOKEN must be supplied through the execution boundary");
  const { run, commands } = createRunner(options.runner, options.token);
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: options.repositoryRoot })).stdout.trim();
  if (head.toLowerCase() !== plan.sourceRevision.toLowerCase()) throw new Error("Repository HEAD does not match the approved Expo source revision");
  const dirty = (await run("git", ["status", "--porcelain", "--", plan.applicationPath], { cwd: options.repositoryRoot })).stdout.trim();
  if (dirty) throw new Error("Expo application files changed after planning");
  const args = plan.operation === "build"
    ? ["build", "--non-interactive", "--no-wait", "--profile", plan.profile ?? "production", "--platform", plan.platform ?? "all"]
    : plan.operation === "submit"
      ? ["submit", "--non-interactive", "--latest", "--profile", plan.profile ?? "production", "--platform", plan.platform ?? "ios"]
      : ["update", "--non-interactive", "--json", "--channel", plan.channel ?? "production", "--message", `vibecore ${plan.sourceRevision}`];
  const result = await run("eas", args, { cwd: joinRoot(options.repositoryRoot, plan.applicationPath), env: { ...process.env, EXPO_TOKEN: options.token } });
  const output = redact(result.stdout + result.stderr, [options.token]).trim();
  const release = createRelease({
    provider: plan.provider, application: plan.application, environment: plan.environment, sourceRevision: plan.sourceRevision,
    digest: plan.digest, files: [], requiredSecretNames: plan.requiredSecretNames, notes: [],
  }, plan.mode, options.now);
  return { release: { ...release, status: plan.operation === "update" ? "healthy" : "deploying" }, output, commands };
}

export class SpawnExpoCommandRunner implements ExpoCommandRunner {
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

function createRunner(runner: ExpoCommandRunner | undefined, token: string) {
  const impl = runner ?? new SpawnExpoCommandRunner();
  const commands: Array<{ command: string; args: string[] }> = [];
  const run: ExpoCommandRunner["run"] = async (command, args, options) => {
    if (`${command} ${args.join(" ")}`.includes(token) || args.includes("--local")) throw new Error("Expo commands must not include EXPO_TOKEN or --local native builds");
    commands.push({ command, args });
    const result = await impl.run(command, args, options);
    if (result.exitCode !== 0) throw new Error(`${command} failed with exit code ${result.exitCode}`);
    return result;
  };
  return { run, commands };
}

function requireExpoApp(manifest: VibecoreManifest, name: string) {
  const application = manifest.applications[name];
  if (!application) throw new Error(`Application is not declared: ${name}`);
  if (application.framework !== "expo" && application.type !== "mobile") throw new Error(`${name} is not an Expo application`);
  if (!manifest.environments) throw new Error("Manifest does not declare environments");
  return application;
}

function verifyPlan(plan: ExpoEasPlan, approval: string): void {
  const { digest, ...semantic } = plan;
  if (approval !== digest) throw new Error("Expo plan approval does not match the generated digest");
  if (digestValue(semantic) !== digest) throw new Error("Expo plan was modified after generation");
}

function joinRoot(root: string, path: string): string {
  return path === "." ? root : `${root.replace(/\/$/, "")}/${path}`;
}

function redact(source: string, secrets: string[]): string {
  return secrets.filter(Boolean).sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join("[REDACTED]"), source);
}

function validateRevision(value: string): void {
  if (!/^[a-f0-9]{7,64}$/i.test(value)) throw new Error("Deployment source revision must be a Git commit SHA");
}

function safeId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} must be a safe identifier`);
  return value;
}

function safeRelativePath(value: string): string {
  if (!value || value.startsWith("/") || value.includes("..") || !/^[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("Application path must be repository-relative and safe");
  return value;
}
