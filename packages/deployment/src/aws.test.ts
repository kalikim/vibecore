import { describe, expect, it, vi } from "vitest";
import type { Release, VibecoreManifest } from "@vibecore/contracts";
import { createRollbackPlan } from "./releases.js";
import { createAwsDeploymentPlan, executeAwsDeploymentPlan, executeAwsRollback, type AwsCommandRunner, type AwsDeploymentMode } from "./aws.js";

const revision = "abcdef1234567890abcdef1234567890abcdef12";
const previous = "1111111111111111111111111111111111111111";
const accountId = "123456789012";
const region = "us-east-1";
const image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const previousImage = "123456789012.dkr.ecr.us-east-1.amazonaws.com/api@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const serviceArn = `arn:aws:apprunner:${region}:${accountId}:service/api/abcdef1234567890`;
const ecsArn = `arn:aws:ecs:${region}:${accountId}:service/cluster/api`;
const taskArn = (revisionNumber: number) => `arn:aws:ecs:${region}:${accountId}:task-definition/api:${revisionNumber}`;
const manifest: VibecoreManifest = {
  apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "app" },
  applications: {
    web: { type: "web", framework: "vite-react", language: "typescript", path: "apps/web", config: { outputDirectory: "dist" } },
    api: { type: "api", framework: "hono", language: "typescript", path: "apps/api", config: { deploymentWorkload: "container", deploymentImage: image, port: 8080 } },
  },
  variables: { DATABASE_URL: { required: true, secret: true, applications: ["api"] } },
  environments: { dev: { runtime: "local-process" }, staging: { runtime: "aws" }, production: { runtime: "aws", production: true } },
};

class AwsRunner implements AwsCommandRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly options: { dirty?: string; account?: string; versioning?: string; publicAccess?: boolean; autoDeploy?: boolean; launchType?: string; publicIp?: string; originBucket?: string; s3List?: string } = {}) {}
  async run(command: string, args: string[]) {
    this.calls.push({ command, args });
    if (command === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: `${revision}\n`, stderr: "" };
    if (command === "git" && args[0] === "status") return { exitCode: 0, stdout: this.options.dirty ?? "", stderr: "" };
    if (command === "test") return { exitCode: 0, stdout: "", stderr: "" };
    if (command === "aws" && args[0] === "sts") return { exitCode: 0, stdout: JSON.stringify({ Account: this.options.account ?? accountId, Arn: `arn:aws:iam::${accountId}:user/dev` }), stderr: "" };
    if (command === "aws" && args[1] === "get-bucket-versioning") return { exitCode: 0, stdout: JSON.stringify({ Status: this.options.versioning ?? "Enabled" }), stderr: "" };
    if (command === "aws" && args[1] === "get-public-access-block") return { exitCode: 0, stdout: JSON.stringify({ PublicAccessBlockConfiguration: { BlockPublicAcls: this.options.publicAccess ?? true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } }), stderr: "" };
    if (command === "aws" && args[1] === "get-distribution-config") return { exitCode: 0, stdout: JSON.stringify({ ETag: "ETAG1", DistributionConfig: { Origins: { Quantity: 1, Items: [{ Id: "site", DomainName: `${this.options.originBucket ?? "app-assets"}.s3.us-east-1.amazonaws.com`, OriginPath: "" }] } } }), stderr: "" };
    if (command === "aws" && args[1] === "create-invalidation") return { exitCode: 0, stdout: JSON.stringify({ Invalidation: { Id: "I123" } }), stderr: "" };
    if (command === "aws" && args[0] === "s3" && args[1] === "ls") return { exitCode: 0, stdout: this.options.s3List ?? "index.html\n", stderr: "" };
    if (command === "aws" && args[0] === "apprunner" && args[1] === "describe-service") return { exitCode: 0, stdout: JSON.stringify({ Service: { ServiceArn: serviceArn, Status: "RUNNING", SourceConfiguration: { AutoDeploymentsEnabled: this.options.autoDeploy ?? false } } }), stderr: "" };
    if (command === "aws" && args[0] === "ecs" && args[1] === "describe-services") return { exitCode: 0, stdout: JSON.stringify({ services: [{ serviceArn: ecsArn, launchType: this.options.launchType ?? "FARGATE", taskDefinition: taskArn(1), networkConfiguration: { awsvpcConfiguration: { assignPublicIp: this.options.publicIp ?? "DISABLED", subnets: ["subnet-1"], securityGroups: ["sg-1"] } } }] }), stderr: "" };
    if (command === "aws" && args[0] === "ecs" && args[1] === "describe-task-definition") return { exitCode: 0, stdout: JSON.stringify({ taskDefinition: { taskDefinitionArn: taskArn(1), revision: 1, status: "ACTIVE", family: "api", cpu: "256", memory: "512", networkMode: "awsvpc", requiresCompatibilities: ["FARGATE"], executionRoleArn: `arn:aws:iam::${accountId}:role/exec`, containerDefinitions: [{ name: "app", image: "old" }], compatibilities: ["FARGATE"], requiresAttributes: [], registeredAt: "2026-01-01T00:00:00Z", registeredBy: "arn:aws:iam::123456789012:user/dev" } }), stderr: "" };
    if (command === "aws" && args[0] === "ecs" && args[1] === "register-task-definition") return { exitCode: 0, stdout: JSON.stringify({ taskDefinition: { taskDefinitionArn: taskArn(2), revision: 2, family: "api" } }), stderr: "" };
    return { exitCode: 0, stdout: "{}", stderr: "" };
  }
}

const makePlan = (mode: AwsDeploymentMode, environment = "staging") => createAwsDeploymentPlan(manifest, {
  application: mode === "s3-cloudfront" ? "web" : "api", environment, sourceRevision: revision, mode, accountId, region, healthUrl: "https://app.example.com/health",
  ...(mode === "s3-cloudfront" ? { bucket: "app-assets", distributionId: "E123456789ABCD" } : {}),
  ...(mode === "app-runner" ? { serviceArn } : {}),
  ...(mode === "ecs-fargate" ? { cluster: "cluster", service: "api" } : {}),
});

describe("AWS deployment plans", () => {
  it("creates a secret-free plan bound to a full revision and account identifiers", () => {
    const plan = makePlan("s3-cloudfront");
    expect(plan).toMatchObject({ provider: "aws", mode: "s3-cloudfront", accountId, region, bucket: "app-assets", requiredSecretNames: [] });
    expect(JSON.stringify(plan)).not.toContain("AKIA");
    expect(() => createAwsDeploymentPlan(manifest, { application: "web", environment: "staging", sourceRevision: "abcdef1", mode: "s3-cloudfront", accountId, region, healthUrl: "https://app.example.com/health", bucket: "app-assets", distributionId: "E123456789ABCD" })).toThrow("full Git");
    expect(makePlan("app-runner").image).toBe(image);
    expect(makePlan("ecs-fargate").cluster).toBe("cluster");
  });

  it("requires container workload and digest-pinned images for App Runner and ECS", () => {
    expect(() => createAwsDeploymentPlan(manifest, { application: "web", environment: "staging", sourceRevision: revision, mode: "app-runner", accountId, region, healthUrl: "https://app.example.com/health", serviceArn })).toThrow("deploymentWorkload: container");
  });
});

describe("AWS execution", () => {
  it("runs no command before exact and production approval", async () => {
    const plan = makePlan("s3-cloudfront", "production");
    const runner = new AwsRunner();
    await expect(executeAwsDeploymentPlan(plan, { approval: "wrong", repositoryRoot: "/repo", runner })).rejects.toThrow("approval");
    await expect(executeAwsDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", runner })).rejects.toThrow("production approval");
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses account drift, dirty trees, public buckets, auto-deploy, and public ECS IPs", async () => {
    const site = makePlan("s3-cloudfront");
    await expect(executeAwsDeploymentPlan(site, { approval: site.digest, repositoryRoot: "/repo", runner: new AwsRunner({ account: "999999999999" }) })).rejects.toThrow("account");
    await expect(executeAwsDeploymentPlan(site, { approval: site.digest, repositoryRoot: "/repo", runner: new AwsRunner({ dirty: " M apps/web/index.ts" }) })).rejects.toThrow("changed");
    await expect(executeAwsDeploymentPlan(site, { approval: site.digest, repositoryRoot: "/repo", runner: new AwsRunner({ versioning: "Suspended" }) })).rejects.toThrow("versioning");
    await expect(executeAwsDeploymentPlan(site, { approval: site.digest, repositoryRoot: "/repo", runner: new AwsRunner({ publicAccess: false }) })).rejects.toThrow("public access");
    const runner = makePlan("app-runner");
    await expect(executeAwsDeploymentPlan(runner, { approval: runner.digest, repositoryRoot: "/repo", runner: new AwsRunner({ autoDeploy: true }) })).rejects.toThrow("automatic deployments");
    const ecs = makePlan("ecs-fargate");
    await expect(executeAwsDeploymentPlan(ecs, { approval: ecs.digest, repositoryRoot: "/repo", runner: new AwsRunner({ publicIp: "ENABLED" }) })).rejects.toThrow("public IP");
  });

  it("syncs a versioned S3 prefix, retargets CloudFront, and invalidates without access keys", async () => {
    const plan = makePlan("s3-cloudfront");
    const runner = new AwsRunner();
    const result = await executeAwsDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", runner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    expect(runner.calls.some(({ args }) => args.includes("sync") && args.includes(`s3://app-assets/releases/${revision}/`))).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("update-distribution"))).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("create-invalidation") && args.includes("/*"))).toBe(true);
    expect(runner.calls.some(({ command, args }) => command === "aws" && args[0] === "configure")).toBe(false);
    expect(runner.calls.flatMap(({ args }) => args).join(" ")).not.toMatch(/secret-access-key|access-key-id|AKIA/i);
    expect(result.release).toMatchObject({ provider: "aws", status: "healthy", providerReleaseId: revision });
    expect(JSON.stringify(result)).not.toContain("AKIA");
  });

  it("updates App Runner with a digest-pinned image and waits for running", async () => {
    const plan = makePlan("app-runner");
    const runner = new AwsRunner();
    const result = await executeAwsDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", runner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    const update = runner.calls.find(({ args }) => args[0] === "apprunner" && args[1] === "update-service");
    expect(update?.args.join(" ")).toContain(image);
    expect(update?.args.join(" ")).toContain('"AutoDeploymentsEnabled":false');
    expect(runner.calls.some(({ args }) => args.includes("wait") && args.includes("service-running"))).toBe(true);
    expect(result.release).toMatchObject({ status: "healthy", providerResourceId: serviceArn, providerReleaseId: image });
  });

  it("registers a new ECS task definition from the current family and waits until stable", async () => {
    const plan = makePlan("ecs-fargate");
    const runner = new AwsRunner();
    const result = await executeAwsDeploymentPlan(plan, { approval: plan.digest, repositoryRoot: "/repo", runner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    expect(runner.calls.some(({ args }) => args.includes("register-task-definition") && args.includes("--cli-input-json"))).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("update-service") && args.includes(taskArn(2)) && args.includes("--force-new-deployment"))).toBe(true);
    expect(result.release).toMatchObject({ status: "healthy", providerResourceId: ecsArn, providerReleaseId: taskArn(2) });
  });
});

describe("AWS rollback", () => {
  const healthy = (overrides: Partial<Release> = {}): Release => ({
    id: "good", application: "web", provider: "aws", mode: "s3-cloudfront", environment: "staging", sourceRevision: previous, planDigest: "digest", status: "healthy",
    createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
    providerResourceId: `aws:s3-cloudfront:${region}:${accountId}:app-assets:E123456789ABCD`, providerReleaseId: previous, ...overrides,
  });

  it("restores the preceding CloudFront origin path and invalidates", async () => {
    const failed = healthy({ id: "bad", sourceRevision: revision, status: "unhealthy", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z", providerReleaseId: revision });
    const plan = createRollbackPlan([failed, healthy()], failed.id);
    const runner = new AwsRunner();
    const result = await executeAwsRollback(plan, [failed, healthy()], { approval: plan.digest, healthUrl: "https://app.example.com/health", runner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    expect(result.failed.status).toBe("rolled-back");
    expect(result.release).toMatchObject({ status: "healthy", rollbackOf: "bad", providerReleaseId: previous });
    expect(runner.calls.some(({ args }) => args.includes("ls") && args.includes(`s3://app-assets/releases/${previous}/`))).toBe(true);
    expect(runner.calls.some(({ args }) => args.includes("create-invalidation"))).toBe(true);
  });

  it("rolls App Runner and ECS back to the recorded image or task definition", async () => {
    const appGood = healthy({ application: "api", mode: "app-runner", providerResourceId: serviceArn, providerReleaseId: previousImage });
    const appFailed = healthy({ id: "bad", application: "api", mode: "app-runner", sourceRevision: revision, status: "unhealthy", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z", providerResourceId: serviceArn, providerReleaseId: image });
    const appPlan = createRollbackPlan([appFailed, appGood], appFailed.id);
    const appRunner = new AwsRunner();
    const appResult = await executeAwsRollback(appPlan, [appFailed, appGood], { approval: appPlan.digest, healthUrl: "https://api.example.com/health", runner: appRunner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    expect(appResult.release.providerReleaseId).toBe(previousImage);
    expect(appRunner.calls.some(({ args }) => args[0] === "apprunner" && args.join(" ").includes(previousImage))).toBe(true);

    const ecsGood = healthy({ application: "api", mode: "ecs-fargate", providerResourceId: ecsArn, providerReleaseId: taskArn(1) });
    const ecsFailed = healthy({ id: "bad-ecs", application: "api", mode: "ecs-fargate", sourceRevision: revision, status: "unhealthy", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z", providerResourceId: ecsArn, providerReleaseId: taskArn(2) });
    const ecsPlan = createRollbackPlan([ecsFailed, ecsGood], ecsFailed.id);
    const ecsRunner = new AwsRunner();
    const ecsResult = await executeAwsRollback(ecsPlan, [ecsFailed, ecsGood], { approval: ecsPlan.digest, healthUrl: "https://api.example.com/health", runner: ecsRunner, healthFetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })) });
    expect(ecsResult.release.providerReleaseId).toBe(taskArn(1));
    expect(ecsRunner.calls.some(({ args }) => args.includes("update-service") && args.includes(taskArn(1)))).toBe(true);
  });
});
