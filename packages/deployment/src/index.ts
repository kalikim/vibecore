import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ApplicationManifest, DeploymentCompatibility, DeploymentConfigurationPlan, DeploymentProviderKind, DeploymentProviderMetadata, DeploymentWorkload, VibecoreManifest } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
export * from "./adapters.js";
export * from "./releases.js";
export * from "./self-hosted.js";
export * from "./railway.js";

const supportedFrameworks = new Set(["next", "nuxt", "remix", "vite-react"]);

const deploymentProviders: DeploymentProviderMetadata[] = [
  {
    id: "vercel", displayName: "Vercel", kind: "managed-platform", costProfiles: ["free-tier", "usage-based"], credentialNames: [],
    modes: [{ id: "git-web", displayName: "Git-connected web application", workloads: ["static", "node"], source: "git", configure: "implemented", preview: "implemented", deploy: "planned", rollback: "planned", notes: ["Repository connection and environment values are completed in Vercel; Vibecore never places a token in generated workflows."] }],
    notes: ["Vibecore currently generates exact-approved preview configuration for supported web frameworks."],
  },
  {
    id: "railway", displayName: "Railway", kind: "managed-platform", costProfiles: ["low-cost", "usage-based"], credentialNames: ["RAILWAY_TOKEN"],
    modes: [
      { id: "git", displayName: "Git source with Railpack", workloads: ["node", "python", "go", "php", "rust", "jvm", "dotnet"], source: "git", configure: "implemented", preview: "planned", deploy: "implemented", rollback: "unsupported", notes: ["Railway builds linked repositories and discovers a start command. Arbitrary historical rollback is not exposed by the Railway CLI."] },
      { id: "dockerfile", displayName: "Dockerfile", workloads: ["container"], source: "container-image", configure: "implemented", preview: "planned", deploy: "implemented", rollback: "unsupported", notes: ["Use this mode when runtime detection is insufficient or reproducible container builds are required. Arbitrary historical rollback is not exposed by the Railway CLI."] },
    ], notes: ["Credential values remain external secret references."],
  },
  {
    id: "aws", displayName: "Amazon Web Services", kind: "cloud", costProfiles: ["free-tier", "usage-based", "infrastructure"], credentialNames: ["AWS_ROLE_ARN", "AWS_REGION"],
    modes: [
      { id: "s3-cloudfront", displayName: "S3 and CloudFront static site", workloads: ["static"], source: "artifact", configure: "implemented", preview: "planned", deploy: "planned", rollback: "planned", notes: ["Designed for static build artifacts only."] },
      { id: "app-runner", displayName: "App Runner service", workloads: ["container"], source: "container-image", configure: "implemented", preview: "planned", deploy: "planned", rollback: "planned", notes: ["Deploys a web service from a container image."] },
      { id: "ecs-fargate", displayName: "ECS on Fargate", workloads: ["container"], source: "container-image", configure: "implemented", preview: "unsupported", deploy: "planned", rollback: "planned", notes: ["Intended for teams that need more infrastructure control."] },
    ], notes: ["GitHub Actions integrations should use OIDC role federation instead of long-lived access keys."],
  },
  {
    id: "azure", displayName: "Microsoft Azure", kind: "cloud", costProfiles: ["free-tier", "usage-based", "infrastructure"], credentialNames: ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID"],
    modes: [
      { id: "static-web-apps", displayName: "Static Web Apps", workloads: ["static"], source: "git", configure: "implemented", preview: "planned", deploy: "planned", rollback: "planned", notes: ["Best fit for static frontends and supported managed API integrations."] },
      { id: "app-service", displayName: "App Service", workloads: ["node", "python", "php", "jvm", "dotnet", "container"], source: "git", configure: "implemented", preview: "planned", deploy: "planned", rollback: "planned", notes: ["Supports managed language runtimes and custom containers."] },
      { id: "container-apps", displayName: "Container Apps", workloads: ["container"], source: "container-image", configure: "implemented", preview: "planned", deploy: "planned", rollback: "planned", notes: ["Managed container target for APIs, web services, and workers."] },
    ], notes: ["GitHub Actions integrations should use Azure workload identity federation instead of client secrets."],
  },
  {
    id: "digitalocean", displayName: "DigitalOcean", kind: "cloud", costProfiles: ["low-cost", "usage-based", "infrastructure"], credentialNames: ["DIGITALOCEAN_ACCESS_TOKEN"],
    modes: [
      { id: "app-platform", displayName: "App Platform", workloads: ["static", "node", "python", "go", "php", "container"], source: "git", configure: "implemented", preview: "planned", deploy: "planned", rollback: "planned", notes: ["Managed source or container deployment."] },
      { id: "droplet", displayName: "Droplet", workloads: ["container"], source: "ssh-sftp", configure: "implemented", preview: "unsupported", deploy: "planned", rollback: "planned", notes: ["Lower-level server deployment; patching and hardening remain the operator's responsibility."] },
    ], notes: ["Droplet support will require SSH host-key verification and non-root deployment users."],
  },
  {
    id: "shared-hosting", displayName: "Shared hosting", kind: "shared-hosting", costProfiles: ["low-cost"], credentialNames: ["DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_SSH_PRIVATE_KEY", "DEPLOY_PATH"],
    modes: [
      { id: "static-sftp", displayName: "Static site over SFTP", workloads: ["static"], source: "ssh-sftp", configure: "implemented", preview: "unsupported", deploy: "planned", rollback: "planned", notes: ["Uploads a versioned static artifact over encrypted SSH transport."] },
      { id: "php-sftp", displayName: "PHP application over SFTP", workloads: ["php"], source: "ssh-sftp", configure: "implemented", preview: "unsupported", deploy: "planned", rollback: "planned", notes: ["Targets hosts with a declared PHP runtime and an application-scoped deployment path."] },
    ], notes: ["Plain FTP and password arguments are intentionally unsupported; credentials must be secret references."],
  },
  {
    id: "self-hosted", displayName: "Self-hosted Docker", kind: "server", costProfiles: ["low-cost", "infrastructure"], credentialNames: ["DEPLOY_SSH_PRIVATE_KEY"],
    modes: [{ id: "docker-compose", displayName: "Versioned Docker Compose over SSH", workloads: ["container"], source: "ssh-sftp", configure: "implemented", preview: "unsupported", deploy: "implemented", rollback: "planned", notes: ["Requires an image pinned by digest, a non-root SSH user, strict host-key verification, and a pre-provisioned environment file."] }],
    notes: ["Rootless Docker is preferred. Vibecore does not install Docker or provision secret values on the host."],
  },
];

export function listDeploymentProviders(kind?: DeploymentProviderKind): DeploymentProviderMetadata[] {
  return deploymentProviders.filter((provider) => !kind || provider.kind === kind).map(copyProvider);
}

export function getDeploymentProvider(id: string): DeploymentProviderMetadata | undefined {
  const normalized = id.toLowerCase() === "digital-ocean" || id.toLowerCase() === "do" ? "digitalocean" : id.toLowerCase();
  const provider = deploymentProviders.find((candidate) => candidate.id === normalized);
  return provider ? copyProvider(provider) : undefined;
}

export function evaluateDeploymentCompatibility(manifest: VibecoreManifest, applicationName: string, providerId: string, modeId: string): DeploymentCompatibility {
  const application = manifest.applications[applicationName];
  if (!application) throw new Error(`Application is not declared: ${applicationName}`);
  const provider = getDeploymentProvider(providerId);
  if (!provider) throw new Error(`Unsupported deployment provider: ${providerId}`);
  const mode = provider.modes.find((candidate) => candidate.id === modeId);
  if (!mode) throw new Error(`Unsupported deployment mode for ${provider.id}: ${modeId}`);
  const workload = inferDeploymentWorkload(application);
  const reasons: string[] = [];
  if (application.type === "mobile") reasons.push("Mobile binaries use an application-store or Expo/EAS release path, not a web deployment target");
  if (!workload) reasons.push(`Vibecore cannot yet map language or framework '${application.language ?? application.framework}' to a deployment workload`);
  else if (!mode.workloads.includes(workload)) reasons.push(`${mode.displayName} does not accept the inferred ${workload} workload`);
  const compatible = reasons.length === 0;
  return { provider: provider.id, mode: mode.id, application: applicationName, ...(workload ? { workload } : {}), compatible, status: compatible ? mode.deploy : "unsupported", reasons };
}

export function inferDeploymentWorkload(application: ApplicationManifest): DeploymentWorkload | undefined {
  if (application.type === "mobile") return undefined;
  const configured = application.config?.deploymentWorkload;
  if (typeof configured === "string" && isDeploymentWorkload(configured)) return configured;
  if (application.type === "web" && ["vite-react", "react", "vue", "svelte", "angular", "static"].includes(application.framework)) return "static";
  const value = (application.language ?? application.framework).toLowerCase();
  if (["javascript", "typescript", "node", "next", "nuxt", "remix", "express", "nestjs", "fastify"].some((candidate) => value.includes(candidate))) return "node";
  if (["python", "django", "flask", "fastapi"].some((candidate) => value.includes(candidate))) return "python";
  if (value === "go" || value.includes("golang") || value.includes("gin") || value.includes("fiber")) return "go";
  if (value.includes("php") || value.includes("laravel") || value.includes("symfony")) return "php";
  if (value.includes("rust") || value.includes("axum") || value.includes("actix")) return "rust";
  if (["java", "kotlin", "spring", "jvm"].some((candidate) => value.includes(candidate))) return "jvm";
  if (["c#", "csharp", ".net", "dotnet", "asp.net"].some((candidate) => value.includes(candidate))) return "dotnet";
  return undefined;
}

function isDeploymentWorkload(value: string): value is DeploymentWorkload { return ["static", "node", "python", "go", "php", "rust", "jvm", "dotnet", "container"].includes(value); }
function copyProvider(provider: DeploymentProviderMetadata): DeploymentProviderMetadata { return { ...provider, costProfiles: [...provider.costProfiles], credentialNames: [...provider.credentialNames], modes: provider.modes.map((mode) => ({ ...mode, workloads: [...mode.workloads], notes: [...mode.notes] })), notes: [...provider.notes] }; }

export function createVercelPreviewPlan(manifest: VibecoreManifest, applicationName: string, sourceRevision: string): DeploymentConfigurationPlan {
  if (!/^[a-f0-9]{7,64}$/i.test(sourceRevision)) throw new Error("Deployment source revision must be a Git commit SHA");
  const application = manifest.applications[applicationName];
  if (!application) throw new Error(`Application is not declared: ${applicationName}`);
  if (application.type !== "web") throw new Error("The Vercel preview adapter currently supports web applications only");
  if (!supportedFrameworks.has(application.framework)) throw new Error(`Vercel preview is not yet configured for ${application.framework}`);
  if (!manifest.environments.staging) throw new Error("The manifest must declare staging before planning a preview deployment");
  const outputDirectory = stringConfig(application.config?.outputDirectory);
  const config = {
    $schema: "https://openapi.vercel.sh/vercel.json",
    framework: vercelFramework(application.framework),
    ...(application.commands?.build ? { buildCommand: application.commands.build } : {}),
    ...(outputDirectory ? { outputDirectory } : {}),
    github: { silent: false },
  };
  const files = [{ path: join(application.path, "vercel.json"), content: `${JSON.stringify(config, null, 2)}\n` }];
  const requiredSecretNames = Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret && (!variable.applications || variable.applications.includes(applicationName))).map(([name]) => name).sort();
  const semantic = { provider: "vercel", application: applicationName, environment: "staging", sourceRevision, files, requiredSecretNames };
  return { ...semantic, digest: digestValue(semantic), notes: ["Connect the GitHub repository and select this application path as the Vercel Root Directory.", "Map staging variables to Vercel Preview and production variables to Vercel Production.", "Enable deployment protection when previews contain private or customer data."] };
}

export async function applyDeploymentConfigurationPlan(root: string, plan: DeploymentConfigurationPlan, approval: string): Promise<string[]> {
  if (approval !== plan.digest) throw new Error("Deployment configuration approval does not match the generated digest");
  const semantic = { provider: plan.provider, application: plan.application, environment: plan.environment, sourceRevision: plan.sourceRevision, files: plan.files, requiredSecretNames: plan.requiredSecretNames };
  if (digestValue(semantic) !== plan.digest) throw new Error("Deployment configuration plan was modified after generation");
  const targets = plan.files.map((file) => ({ ...file, absolute: safeTarget(root, file.path) }));
  for (const target of targets) { try { await access(target.absolute); throw new Error(`${target.path} already exists; deployment setup will not overwrite it`); } catch (error) { if (!isMissing(error)) throw error; } }
  for (const target of targets) { await mkdir(dirname(target.absolute), { recursive: true }); await writeFile(target.absolute, target.content, { flag: "wx", mode: 0o644 }); }
  return targets.map(({ path }) => path);
}

function vercelFramework(framework: string): string { return framework === "vite-react" ? "vite" : framework; }
function stringConfig(value: unknown): string | undefined { if (value === undefined) return undefined; if (typeof value !== "string" || value.includes("..") || isAbsolute(value)) throw new Error("Deployment outputDirectory must be a safe relative path"); return value; }
function safeTarget(root: string, path: string): string { if (isAbsolute(path)) throw new Error("Deployment target must be repository-relative"); const target = resolve(root, path); const rel = relative(resolve(root), target); if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Deployment target escapes the repository"); return target; }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"; }
