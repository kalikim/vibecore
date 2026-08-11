import { describe, expect, it } from "vitest";
import type { ApplicationManifest, VibecoreManifest } from "@vibecore/contracts";
import { createDeploymentConfigurationPlan } from "./adapters.js";

function manifest(application: ApplicationManifest): VibecoreManifest {
  return {
    apiVersion: "vibecore.dev/v1alpha1", kind: "Application", metadata: { name: "ship-safe" },
    applications: { app: application },
    variables: { DATABASE_URL: { required: true, secret: true, applications: ["app"] }, PUBLIC_URL: { required: true } },
    environments: { dev: { runtime: "local-process" }, staging: { runtime: "github-actions" }, production: { runtime: "github-actions", production: true } },
  };
}

const nodeApp: ApplicationManifest = { type: "api", framework: "express", language: "typescript", path: "apps/api", commands: { build: "pnpm build", start: "node dist/index.js" }, health: { path: "/health", timeoutSeconds: 45 }, config: { port: 8080 } };
const staticApp: ApplicationManifest = { type: "web", framework: "vite-react", language: "typescript", path: "apps/web", commands: { build: "pnpm build" }, config: { outputDirectory: "dist" } };
const containerApp: ApplicationManifest = { ...nodeApp, config: { port: 8080, deploymentWorkload: "container" } };
const phpApp: ApplicationManifest = { type: "web", framework: "laravel", language: "php", path: "apps/php", commands: { build: "composer install --no-dev" } };

describe("provider deployment configuration adapters", () => {
  const cases: Array<[string, string, ApplicationManifest, string]> = [
    ["railway", "git", nodeApp, "railway.json"],
    ["railway", "dockerfile", containerApp, "railway.json"],
    ["aws", "s3-cloudfront", staticApp, "template.yaml"],
    ["aws", "app-runner", containerApp, "template.yaml"],
    ["aws", "ecs-fargate", containerApp, "template.yaml"],
    ["azure", "static-web-apps", staticApp, "main.bicep"],
    ["azure", "app-service", nodeApp, "main.bicep"],
    ["azure", "container-apps", containerApp, "main.bicep"],
    ["digitalocean", "app-platform", nodeApp, ".do/app.yaml"],
    ["digitalocean", "droplet", containerApp, "cloud-init.yaml"],
    ["shared-hosting", "static-sftp", staticApp, "sftp-release.json"],
    ["shared-hosting", "php-sftp", phpApp, "sftp-release.json"],
  ];

  it.each(cases)("generates %s/%s configuration", (provider, mode, application, expectedFile) => {
    const plan = createDeploymentConfigurationPlan(manifest(application), { provider, mode, application: "app", environment: "staging", sourceRevision: "abcdef1234567" });
    expect(plan.provider).toBe(provider);
    expect(plan.files.some(({ path }) => path.endsWith(expectedFile))).toBe(true);
    expect(plan.files.some(({ path }) => path.endsWith("deployment.json"))).toBe(true);
    expect(plan.requiredSecretNames).toContain("DATABASE_URL");
    expect(JSON.stringify(plan)).not.toContain("postgresql://");
    expect(plan.notes.join(" ")).toContain("no remote resource was created");
  });

  it("uses workload and immutable-revision validation before generating files", () => {
    expect(() => createDeploymentConfigurationPlan(manifest(nodeApp), { provider: "aws", mode: "s3-cloudfront", application: "app", environment: "staging", sourceRevision: "abcdef1234567" })).toThrow("does not accept");
    expect(() => createDeploymentConfigurationPlan(manifest(nodeApp), { provider: "railway", mode: "git", application: "app", environment: "staging", sourceRevision: "main" })).toThrow("commit SHA");
    expect(() => createDeploymentConfigurationPlan(manifest({ ...nodeApp, commands: { build: "pnpm build" } }), { provider: "digitalocean", mode: "app-platform", application: "app", environment: "staging", sourceRevision: "abcdef1234567" })).toThrow("commands.start");
  });

  it("keeps identity configuration out of the secret-value contract", () => {
    const aws = createDeploymentConfigurationPlan(manifest(containerApp), { provider: "aws", mode: "app-runner", application: "app", environment: "production", sourceRevision: "abcdef1234567" });
    expect(aws.requiredSecretNames).toEqual(["DATABASE_URL"]);
    const shared = createDeploymentConfigurationPlan(manifest(staticApp), { provider: "shared-hosting", mode: "static-sftp", application: "app", environment: "production", sourceRevision: "abcdef1234567" });
    expect(shared.requiredSecretNames).toEqual(["DATABASE_URL", "DEPLOY_SSH_PRIVATE_KEY"]);
  });
});
