import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { DeploymentHealthResult, DeploymentRollbackPlan, Release, VibecoreManifest } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
import { applyHealthResult, createRelease, recordRollback, verifyDeploymentHealth } from "./releases.js";

export type AwsDeploymentMode = "s3-cloudfront" | "app-runner" | "ecs-fargate";

export interface AwsDeploymentPlan {
  provider: "aws";
  mode: AwsDeploymentMode;
  application: string;
  applicationPath: string;
  environment: string;
  sourceRevision: string;
  accountId: string;
  region: string;
  healthUrl: string;
  requiredSecretNames: string[];
  bucket?: string;
  distributionId?: string;
  serviceArn?: string;
  cluster?: string;
  service?: string;
  image?: string;
  outputDirectory?: string;
  port?: number;
  digest: string;
}

export interface AwsCommandRunner { run(command: string, args: string[], options?: { cwd?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>; }
export interface AwsDeploymentResult { release: Release; health: DeploymentHealthResult; commands: Array<{ command: string; args: string[] }>; }
export interface AwsRollbackResult { failed: Release; release: Release; health: DeploymentHealthResult; commands: Array<{ command: string; args: string[] }>; }

type AwsRun = (command: string, args: string[], options?: { cwd?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const awsModes = new Set<AwsDeploymentMode>(["s3-cloudfront", "app-runner", "ecs-fargate"]);

export function createAwsDeploymentPlan(manifest: VibecoreManifest, options: {
  application: string;
  environment: string;
  sourceRevision: string;
  mode: AwsDeploymentMode;
  accountId: string;
  region: string;
  healthUrl: string;
  bucket?: string;
  distributionId?: string;
  serviceArn?: string;
  cluster?: string;
  service?: string;
}): AwsDeploymentPlan {
  const application = manifest.applications[options.application];
  if (!application) throw new Error(`Application is not declared: ${options.application}`);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  if (!awsModes.has(options.mode)) throw new Error("AWS mode must be s3-cloudfront, app-runner, or ecs-fargate");
  if (!/^[a-f0-9]{40,64}$/i.test(options.sourceRevision)) throw new Error("AWS deployment requires a full Git commit SHA");
  const applicationPath = safeRelativePath(application.path);
  const accountId = safeAccountId(options.accountId);
  const region = safeRegion(options.region);
  const healthUrl = safeHealthUrl(options.healthUrl);
  const container = options.mode === "app-runner" || options.mode === "ecs-fargate";
  if (container && application.config?.deploymentWorkload !== "container") throw new Error("AWS container modes require config.deploymentWorkload: container");
  const image = container ? immutableImage(application.config?.deploymentImage) : undefined;
  const outputDirectory = options.mode === "s3-cloudfront" ? safeRelativePath(typeof application.config?.outputDirectory === "string" ? application.config.outputDirectory : "dist") : undefined;
  const configuredPort = application.config?.port;
  const port = container && Number.isInteger(configuredPort) ? configuredPort as number : container ? 3000 : undefined;
  const bucket = options.mode === "s3-cloudfront" ? safeBucket(options.bucket ?? "") : undefined;
  const distributionId = options.mode === "s3-cloudfront" ? safeDistributionId(options.distributionId ?? "") : undefined;
  const serviceArn = options.mode === "app-runner" ? safeAppRunnerArn(options.serviceArn ?? "", accountId, region) : undefined;
  const cluster = options.mode === "ecs-fargate" ? safeIdentifier(options.cluster ?? "", "ECS cluster") : undefined;
  const service = options.mode === "ecs-fargate" ? safeIdentifier(options.service ?? "", "ECS service") : undefined;
  const requiredSecretNames = Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret && (!variable.applications || variable.applications.includes(options.application))).map(([name]) => name).sort();
  const semantic = {
    provider: "aws" as const, mode: options.mode, application: options.application, applicationPath, environment: options.environment,
    sourceRevision: options.sourceRevision, accountId, region, healthUrl, requiredSecretNames,
    ...(bucket ? { bucket } : {}), ...(distributionId ? { distributionId } : {}), ...(serviceArn ? { serviceArn } : {}),
    ...(cluster ? { cluster } : {}), ...(service ? { service } : {}), ...(image ? { image } : {}),
    ...(outputDirectory ? { outputDirectory } : {}), ...(port ? { port } : {}),
  };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function executeAwsDeploymentPlan(plan: AwsDeploymentPlan, options: { approval: string; repositoryRoot: string; productionApproved?: boolean; runner?: AwsCommandRunner; healthFetch?: typeof fetch; now?: Date }): Promise<AwsDeploymentResult> {
  verifyPlan(plan, options.approval);
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production AWS deployment requires explicit production approval");
  const { run, commands } = createRunner(options.runner);
  await verifyAwsIdentity(plan, run);
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: options.repositoryRoot })).stdout.trim();
  if (head.toLowerCase() !== plan.sourceRevision.toLowerCase()) throw new Error("Repository HEAD does not match the approved AWS source revision");
  const dirty = (await run("git", ["status", "--porcelain", "--", plan.applicationPath, `.vibecore/deployments/aws-${plan.mode}`], { cwd: options.repositoryRoot })).stdout.trim();
  if (dirty) throw new Error("Application or AWS configuration changed after planning");
  const deployed = await deployAws(plan, options.repositoryRoot, run);
  const release = { ...createRelease({ provider: plan.provider, application: plan.application, environment: plan.environment, sourceRevision: plan.sourceRevision, digest: plan.digest, files: [], requiredSecretNames: plan.requiredSecretNames, notes: [] }, plan.mode, options.now), providerResourceId: deployed.resourceId, providerReleaseId: deployed.releaseId };
  const health = await verifyDeploymentHealth(plan.healthUrl, { attempts: 6, timeoutSeconds: 20, intervalMs: 5000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
  return { release: applyHealthResult(release, health), health, commands };
}

export async function executeAwsRollback(plan: DeploymentRollbackPlan, releases: Release[], options: { approval: string; healthUrl: string; productionApproved?: boolean; runner?: AwsCommandRunner; healthFetch?: typeof fetch; now?: Date }): Promise<AwsRollbackResult> {
  if (plan.provider !== "aws" || !awsModes.has(plan.mode as AwsDeploymentMode) || !plan.providerResourceId || !plan.targetProviderReleaseId) throw new Error("Rollback plan lacks AWS resource identifiers");
  if (plan.environment === "production" && !options.productionApproved) throw new Error("Production AWS rollback requires explicit production approval");
  const staged = recordRollback(releases, plan, options.approval, options.now);
  const { run, commands } = createRunner(options.runner);
  const target = parseAwsResourceId(plan.providerResourceId, plan.mode as AwsDeploymentMode);
  await verifyAwsIdentity({ accountId: target.accountId, region: target.region }, run);
  const providerReleaseId = await rollbackAws(plan, target, run);
  const health = await verifyDeploymentHealth(safeHealthUrl(options.healthUrl), { attempts: 6, timeoutSeconds: 20, intervalMs: 5000, ...(options.healthFetch ? { fetch: options.healthFetch } : {}) });
  const release = applyHealthResult({ ...staged.rollback, providerResourceId: plan.providerResourceId, providerReleaseId }, health);
  return { failed: staged.failed, release, health, commands };
}

export class SpawnAwsCommandRunner implements AwsCommandRunner {
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

function createRunner(runner?: AwsCommandRunner): { run: AwsRun; commands: Array<{ command: string; args: string[] }> } {
  const impl = runner ?? new SpawnAwsCommandRunner();
  const commands: Array<{ command: string; args: string[] }> = [];
  const run: AwsRun = async (command, args, options) => {
    assertSafeAwsInvocation(command, args);
    commands.push({ command, args });
    const result = await impl.run(command, args, options);
    if (result.exitCode !== 0) throw new Error(`${command} failed with exit code ${result.exitCode}`);
    return result;
  };
  return { run, commands };
}

async function verifyAwsIdentity(plan: { accountId: string; region: string }, run: AwsRun): Promise<void> {
  const identity = parseJsonObject((await run("aws", ["sts", "get-caller-identity", "--region", plan.region, "--output", "json"])).stdout, "AWS caller identity");
  if (String(identity.Account ?? "") !== plan.accountId) throw new Error("AWS caller identity does not match the approved account");
}

async function deployAws(plan: AwsDeploymentPlan, repositoryRoot: string, run: AwsRun): Promise<{ resourceId: string; releaseId: string }> {
  if (plan.mode === "s3-cloudfront") return deployStaticSite(plan, repositoryRoot, run);
  if (plan.mode === "app-runner") return deployAppRunner(plan, run);
  return deployEcsFargate(plan, run);
}

async function rollbackAws(plan: DeploymentRollbackPlan, target: AwsResourceTarget, run: AwsRun): Promise<string> {
  const previous = plan.targetProviderReleaseId;
  if (!previous) throw new Error("Rollback plan lacks the preceding AWS release identifier");
  if (plan.mode === "s3-cloudfront") {
    if (!target.bucket || !target.distributionId) throw new Error("Rollback plan lacks S3 bucket and CloudFront distribution identifiers");
    const prefix = `s3://${target.bucket}/releases/${plan.targetSourceRevision}/`;
    const listed = (await run("aws", ["s3", "ls", prefix, "--region", target.region])).stdout.trim();
    if (!listed) throw new Error("Preceding S3 release prefix is missing; the versioned artifact cannot be restored");
    await updateOriginPath(target.distributionId, target.bucket, target.region, plan.targetSourceRevision, run);
    return plan.targetSourceRevision;
  }
  if (plan.mode === "app-runner") {
    if (!target.serviceArn || !isImage(previous)) throw new Error("App Runner rollback requires the preceding digest-pinned image");
    await run("aws", ["apprunner", "update-service", "--region", target.region, "--service-arn", target.serviceArn, "--source-configuration", appRunnerSource(previous, 3000), "--output", "json"]);
    await run("aws", ["apprunner", "wait", "service-running", "--region", target.region, "--service-arn", target.serviceArn]);
    return previous;
  }
  if (!target.cluster || !target.service) throw new Error("ECS rollback requires cluster and service identifiers");
  const taskDefinition = safeTaskDefinitionArn(previous, target.accountId, target.region);
  await run("aws", ["ecs", "update-service", "--region", target.region, "--cluster", target.cluster, "--service", target.service, "--task-definition", taskDefinition, "--force-new-deployment", "--output", "json"]);
  await run("aws", ["ecs", "wait", "services-stable", "--region", target.region, "--cluster", target.cluster, "--services", target.service]);
  return taskDefinition;
}

async function deployStaticSite(plan: AwsDeploymentPlan, repositoryRoot: string, run: AwsRun): Promise<{ resourceId: string; releaseId: string }> {
  if (!plan.bucket || !plan.distributionId) throw new Error("S3 and CloudFront deployment requires a bucket and distribution ID");
  const relativeOutput = join(plan.applicationPath, plan.outputDirectory ?? "dist");
  safeRepositoryPath(repositoryRoot, relativeOutput);
  try { await run("test", ["-d", relativeOutput], { cwd: repositoryRoot }); } catch { throw new Error(`S3 artifact directory '${relativeOutput}' is missing; build the approved revision before deploying`); }
  const versioning = parseJsonObject((await run("aws", ["s3api", "get-bucket-versioning", "--bucket", plan.bucket, "--region", plan.region, "--output", "json"])).stdout, "S3 versioning");
  if (String(versioning.Status ?? "") !== "Enabled") throw new Error("S3 bucket versioning must be enabled before exact-approved deployments");
  const block = parseJsonObject((await run("aws", ["s3api", "get-public-access-block", "--bucket", plan.bucket, "--region", plan.region, "--output", "json"])).stdout, "S3 public access block");
  const config = object(block.PublicAccessBlockConfiguration) ?? {};
  if (![config.BlockPublicAcls, config.IgnorePublicAcls, config.BlockPublicPolicy, config.RestrictPublicBuckets].every((value) => value === true)) throw new Error("S3 public access block must be fully enabled");
  await verifyDistributionOrigin(plan.distributionId, plan.bucket, plan.region, run);
  const destination = `s3://${plan.bucket}/releases/${plan.sourceRevision}/`;
  await run("aws", ["s3", "sync", relativeOutput, destination, "--region", plan.region, "--delete", "--only-show-errors"], { cwd: repositoryRoot });
  await updateOriginPath(plan.distributionId, plan.bucket, plan.region, plan.sourceRevision, run);
  return { resourceId: s3ResourceId(plan), releaseId: plan.sourceRevision };
}

async function deployAppRunner(plan: AwsDeploymentPlan, run: AwsRun): Promise<{ resourceId: string; releaseId: string }> {
  if (!plan.serviceArn || !plan.image) throw new Error("App Runner deployment requires a service ARN and digest-pinned image");
  const described = parseJsonObject((await run("aws", ["apprunner", "describe-service", "--region", plan.region, "--service-arn", plan.serviceArn, "--output", "json"])).stdout, "App Runner service");
  const service = object(described.Service) ?? {};
  if (nested(service, "SourceConfiguration", "AutoDeploymentsEnabled") !== false) throw new Error("Disable App Runner automatic deployments before using exact-approved Vibecore deployments");
  await run("aws", ["apprunner", "update-service", "--region", plan.region, "--service-arn", plan.serviceArn, "--source-configuration", appRunnerSource(plan.image, plan.port ?? 3000), "--output", "json"]);
  await run("aws", ["apprunner", "wait", "service-running", "--region", plan.region, "--service-arn", plan.serviceArn]);
  return { resourceId: plan.serviceArn, releaseId: plan.image };
}

async function deployEcsFargate(plan: AwsDeploymentPlan, run: AwsRun): Promise<{ resourceId: string; releaseId: string }> {
  if (!plan.cluster || !plan.service || !plan.image) throw new Error("ECS Fargate deployment requires a cluster, service, and digest-pinned image");
  const described = parseJsonObject((await run("aws", ["ecs", "describe-services", "--region", plan.region, "--cluster", plan.cluster, "--services", plan.service, "--output", "json"])).stdout, "ECS service");
  const service = object(Array.isArray(described.services) ? described.services[0] : undefined);
  if (!service) throw new Error("ECS service was not found");
  if (service.launchType !== "FARGATE") throw new Error("ECS Fargate mode requires an existing Fargate launch type");
  if (nested(service, "networkConfiguration", "awsvpcConfiguration", "assignPublicIp") !== "DISABLED") throw new Error("ECS Fargate services must assign a disabled public IP and use private subnets");
  const currentArn = String(service.taskDefinition ?? "");
  const current = parseJsonObject((await run("aws", ["ecs", "describe-task-definition", "--region", plan.region, "--task-definition", currentArn, "--output", "json"])).stdout, "ECS task definition");
  const registered = parseJsonObject((await registerTaskDefinition(plan, current, run)).stdout, "ECS registered task definition");
  const taskDefinitionArn = safeTaskDefinitionArn(String(nested(registered, "taskDefinition", "taskDefinitionArn") ?? ""), plan.accountId, plan.region);
  await run("aws", ["ecs", "update-service", "--region", plan.region, "--cluster", plan.cluster, "--service", plan.service, "--task-definition", taskDefinitionArn, "--force-new-deployment", "--output", "json"]);
  await run("aws", ["ecs", "wait", "services-stable", "--region", plan.region, "--cluster", plan.cluster, "--services", plan.service]);
  return { resourceId: String(service.serviceArn ?? ecsServiceArn(plan)), releaseId: taskDefinitionArn };
}

async function registerTaskDefinition(plan: AwsDeploymentPlan, described: Record<string, unknown>, run: AwsRun): Promise<{ stdout: string }> {
  const source = object(described.taskDefinition);
  if (!source) throw new Error("ECS task definition JSON is invalid");
  const containers = Array.isArray(source.containerDefinitions) ? source.containerDefinitions.map((container) => object(container)).filter((value): value is Record<string, unknown> => Boolean(value)) : [];
  const target = containers.length === 1 ? containers[0] : containers.find((container) => container.name === "app");
  if (!target) throw new Error("ECS task definition must contain a single container or a container named app");
  target.image = plan.image;
  const payload: Record<string, unknown> = {
    family: source.family, cpu: source.cpu, memory: source.memory, networkMode: source.networkMode, executionRoleArn: source.executionRoleArn,
    requiresCompatibilities: source.requiresCompatibilities, containerDefinitions: containers,
    ...(source.taskRoleArn ? { taskRoleArn: source.taskRoleArn } : {}), ...(source.runtimePlatform ? { runtimePlatform: source.runtimePlatform } : {}),
  };
  const temporary = await mkdtemp(join(tmpdir(), "vibecore-aws-"));
  const file = join(temporary, "task-definition.json");
  try {
    await writeFile(file, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
    return await run("aws", ["ecs", "register-task-definition", "--region", plan.region, "--cli-input-json", `file://${file}`, "--output", "json"]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function verifyDistributionOrigin(distributionId: string, bucket: string, region: string, run: AwsRun): Promise<Record<string, unknown>> {
  const described = parseJsonObject((await run("aws", ["cloudfront", "get-distribution-config", "--id", distributionId, "--region", region, "--output", "json"])).stdout, "CloudFront distribution");
  const items = nested(described, "DistributionConfig", "Origins", "Items");
  const origins = Array.isArray(items) ? items.map((item) => object(item)).filter((value): value is Record<string, unknown> => Boolean(value)) : [];
  if (!origins.some((origin) => String(origin.DomainName ?? "").includes(bucket))) throw new Error("CloudFront distribution origin does not match the approved S3 bucket");
  return described;
}

async function updateOriginPath(distributionId: string, bucket: string, region: string, revision: string, run: AwsRun): Promise<void> {
  const described = await verifyDistributionOrigin(distributionId, bucket, region, run);
  const etag = String(described.ETag ?? "");
  if (!etag) throw new Error("CloudFront distribution config is missing an ETag");
  const config = object(described.DistributionConfig);
  if (!config) throw new Error("CloudFront distribution config is missing");
  const items = nested(config, "Origins", "Items");
  if (!Array.isArray(items)) throw new Error("CloudFront distribution has no origins");
  for (const item of items) {
    const origin = object(item);
    if (origin && String(origin.DomainName ?? "").includes(bucket)) origin.OriginPath = `/releases/${revision}`;
  }
  const temporary = await mkdtemp(join(tmpdir(), "vibecore-aws-cf-"));
  const file = join(temporary, "distribution.json");
  try {
    await writeFile(file, `${JSON.stringify(config)}\n`, { mode: 0o600, flag: "wx" });
    await run("aws", ["cloudfront", "update-distribution", "--id", distributionId, "--if-match", etag, "--distribution-config", `file://${file}`, "--region", region, "--output", "json"]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  const invalidation = parseJsonObject((await run("aws", ["cloudfront", "create-invalidation", "--distribution-id", distributionId, "--paths", "/*", "--region", region, "--output", "json"])).stdout, "CloudFront invalidation");
  const invalidationId = String(nested(invalidation, "Invalidation", "Id") ?? "");
  if (invalidationId) await run("aws", ["cloudfront", "wait", "invalidation-completed", "--distribution-id", distributionId, "--id", invalidationId, "--region", region]);
}

interface AwsResourceTarget { accountId: string; region: string; bucket?: string; distributionId?: string; serviceArn?: string; cluster?: string; service?: string }

function parseAwsResourceId(value: string, mode: AwsDeploymentMode): AwsResourceTarget {
  if (mode === "s3-cloudfront") {
    const match = value.match(/^aws:s3-cloudfront:([a-z]{2}-[a-z]+-\d+):(\d{12}):([a-z0-9.-]{3,63}):(E[A-Z0-9]{8,16})$/);
    if (!match?.[1] || !match[2] || !match[3] || !match[4]) throw new Error("AWS S3 resource ID is unsafe or incomplete");
    return { region: match[1], accountId: match[2], bucket: match[3], distributionId: match[4] };
  }
  if (mode === "app-runner") {
    const match = value.match(/^arn:aws:apprunner:([a-z]{2}-[a-z]+-\d+):(\d{12}):service\/[A-Za-z0-9._/-]+$/);
    if (!match?.[1] || !match[2]) throw new Error("App Runner service ARN is unsafe");
    return { region: match[1], accountId: match[2], serviceArn: value };
  }
  const match = value.match(/^arn:aws:ecs:([a-z]{2}-[a-z]+-\d+):(\d{12}):service\/([^/]+)\/([^/]+)$/);
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) throw new Error("ECS service ARN must include the cluster and service names");
  return { region: match[1], accountId: match[2], cluster: match[3], service: match[4] };
}

function s3ResourceId(plan: AwsDeploymentPlan): string { return `aws:s3-cloudfront:${plan.region}:${plan.accountId}:${plan.bucket}:${plan.distributionId}`; }
function ecsServiceArn(plan: AwsDeploymentPlan): string { return `arn:aws:ecs:${plan.region}:${plan.accountId}:service/${plan.cluster}/${plan.service}`; }
function appRunnerSource(image: string, port: number): string {
  return JSON.stringify({ AutoDeploymentsEnabled: false, ImageRepository: { ImageIdentifier: image, ImageRepositoryType: image.startsWith("public.ecr.aws/") ? "ECR_PUBLIC" : "ECR", ImageConfiguration: { Port: String(port) } } });
}

function verifyPlan(plan: AwsDeploymentPlan, approval: string): void {
  const { digest, ...semantic } = plan;
  if (approval !== digest) throw new Error("AWS deployment approval does not match the generated digest");
  if (digestValue(semantic) !== digest) throw new Error("AWS deployment plan was modified after generation");
}

function assertSafeAwsInvocation(command: string, args: string[]): void {
  if (command === "aws" && args[0] === "configure") throw new Error("AWS execution uses the current CLI identity and will not run aws configure");
  const joined = args.join(" ").toLowerCase();
  if (joined.includes("secret-access-key") || joined.includes("access-key-id") || joined.includes("session-token") || joined.includes("--secret") || joined.includes("aws_secret")) {
    throw new Error("AWS execution refuses access keys, secret keys, and session tokens in command arguments");
  }
}

function immutableImage(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/.test(value)) throw new Error("AWS container deployment requires config.deploymentImage pinned with @sha256:<64 lowercase hex characters>");
  return value;
}

function isImage(value: string): boolean { return /@sha256:[a-f0-9]{64}$/.test(value); }
function safeAccountId(value: string): string { if (!/^\d{12}$/.test(value)) throw new Error("AWS account ID must be 12 digits"); return value; }
function safeRegion(value: string): string { if (!/^[a-z]{2}-[a-z]+-\d+$/.test(value)) throw new Error("AWS region is unsafe"); return value; }
function safeBucket(value: string): string { if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) || value.includes("..") || value.includes(".-") || value.includes("-.")) throw new Error("S3 bucket name is unsafe"); return value; }
function safeDistributionId(value: string): string { if (!/^E[A-Z0-9]{8,16}$/.test(value)) throw new Error("CloudFront distribution ID is unsafe"); return value; }
function safeAppRunnerArn(value: string, accountId: string, region: string): string {
  if (!/^arn:aws:apprunner:[a-z]{2}-[a-z]+-\d+:\d{12}:service\/[A-Za-z0-9._/-]+$/.test(value)) throw new Error("App Runner service ARN is unsafe");
  if (!value.includes(`:${region}:`) || !value.includes(`:${accountId}:`)) throw new Error("App Runner service ARN must match the approved account and region");
  return value;
}
function safeTaskDefinitionArn(value: string, accountId: string, region: string): string {
  if (!/^arn:aws:ecs:[a-z]{2}-[a-z]+-\d+:\d{12}:task-definition\/[A-Za-z0-9_-]+:\d+$/.test(value)) throw new Error("ECS task definition ARN is unsafe");
  if (!value.includes(`:${region}:`) || !value.includes(`:${accountId}:`)) throw new Error("ECS task definition ARN must match the approved account and region");
  return value;
}
function safeIdentifier(value: string, label: string): string { if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} must be a safe name or identifier`); return value; }
function safeRelativePath(value: string): string { if (!value || value.startsWith("/") || value.includes("..") || !/^[a-zA-Z0-9._/-]+$/.test(value)) throw new Error("Application path must be repository-relative and safe"); return value; }
function safeRepositoryPath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error("AWS artifact path must be repository-relative");
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("AWS artifact path escapes the repository");
  return target;
}
function safeHealthUrl(value: string): string { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Health URL must be HTTP(S) without embedded credentials"); url.hash = ""; return url.toString(); }
function parseJsonObject(source: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { throw new Error(`${label} JSON is invalid`); }
  const value = object(parsed);
  if (!value) throw new Error(`${label} JSON must be an object`);
  return value;
}
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function nested(value: unknown, ...path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) { current = object(current)?.[key]; if (current === undefined) return undefined; }
  return current;
}
