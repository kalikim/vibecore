import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepositoryScan, VibecoreManifest } from "@codexsafari/vibecore-contracts";
import { digestValue } from "./index.js";

export interface ResourcePlan {
  version: "vibecore.resource-plan/v1";
  kind: "advisory";
  environment: string;
  budgetConscious: boolean;
  inputDigest: string;
  summary: { applications: number; resources: number; declaredSecretNames: string[] };
  findings: Array<{ code: string; severity: "warning" | "error"; message: string }>;
  steps: Array<{ id: string; command: string; purpose: string }>;
  resourcePolicy: {
    networkCalls: 0; aiCalls: 0; estimatedCloudCost: "unknown";
    execution: "disabled"; approvalRequired: string[];
  };
  guidance: string[];
  limitations: string[];
  digest: string;
}

export function createResourcePlan(input: {
  scan: RepositoryScan;
  manifest?: VibecoreManifest;
  environment: string;
  budgetConscious: boolean;
  githubWorkflowPresent: boolean;
}): ResourcePlan {
  const { scan, manifest, environment, budgetConscious } = input;
  if (!["dev", "staging", "production"].includes(environment)) throw new Error("Plan environment must be dev, staging, or production");
  const findings: ResourcePlan["findings"] = [];
  const steps: ResourcePlan["steps"] = [];
  if (!manifest) {
    findings.push({ code: "manifest.missing", severity: "warning", message: "No manifest found; review a proposal before configuring resources." });
    steps.push({ id: "manifest", command: scan.applications.length ? "vibe adopt" : "vibe init --list", purpose: "Inspect a manifest proposal or available blueprints; no application source is generated." });
  } else {
    if (!manifest.environments[environment]) findings.push({ code: "environment.missing", severity: "error", message: "The requested environment is not declared in the manifest." });
    if (environment === "production" && !manifest.environments.production?.production) findings.push({ code: "production.unprotected", severity: "error", message: "The production environment must explicitly set production: true." });
    steps.push({ id: "diagnostics", command: `vibe doctor --environment ${environment}`, purpose: "Review project and environment diagnostics before any remote operation." });
  }
  if (!input.githubWorkflowPresent) findings.push({ code: "github.workflow.missing", severity: "warning", message: "No local GitHub Actions workflow was found; generated deployment gates still need an execution adapter." });
  const resources = manifest ? Object.keys(manifest.resources ?? {}).length : scan.resources.length;
  if (resources) steps.push({ id: "database", command: "vibe db support", purpose: "Check engine/tool/provider capabilities and reuse existing resources before provisioning anything." });
  const applications = manifest ? Object.values(manifest.applications) : scan.applications;
  if (applications.some((app) => app.type === "api")) steps.push({ id: "api-docs", command: "vibe api adapters", purpose: "Review OpenAPI/Swagger support before generating documentation." });
  if (applications.some((app) => app.type === "mobile")) steps.push({ id: "mobile", command: "vibe expo inspect --help", purpose: "Review EAS profiles before starting potentially billable native builds." });
  steps.push({ id: "deployment", command: "vibe deploy support", purpose: "Compare supported deployment modes; existing resources are not verified by this local scan." });
  const semantic: Omit<ResourcePlan, "digest"> = {
    version: "vibecore.resource-plan/v1", kind: "advisory", environment, budgetConscious,
    inputDigest: digestValue({ fingerprint: scan.fingerprint, manifest: manifest ?? null, workflow: input.githubWorkflowPresent }),
    summary: { applications: applications.length, resources, declaredSecretNames: Object.entries(manifest?.variables ?? {}).filter(([, value]) => value.secret).map(([name]) => name).sort() },
    findings, steps,
    resourcePolicy: { networkCalls: 0, aiCalls: 0, estimatedCloudCost: "unknown", execution: "disabled", approvalRequired: ["billable cloud operations", "native cloud builds", "database changes", "production operations", "destructive operations"] },
    guidance: [
      "Reuse this compact report as coding-agent context instead of repeatedly supplying the whole repository. Token savings are not measured.",
      "Confirm ownership, capacity, isolation, and backups before reusing an existing database or deployment target.",
      ...(budgetConscious ? ["Prefer local validation before remote previews; local CPU, storage, and electricity are still resources.", "Avoid duplicate preview environments and repeated native builds. Review provider quotas and cleanup requirements before spending."] : []),
    ],
    limitations: ["Advisory only: this report cannot be applied as an executor plan.", "Cloud prices, quotas, existing remote resources, credentials, and secret values were not queried.", "Freshness covers discovery inputs, the parsed manifest, and workflow presence, not every source file or remote state.", "Use operation-specific plans and their exact approvals to execute changes; production and destructive safeguards still apply."],
  };
  return { ...semantic, digest: digestValue(semantic) };
}

export function verifyResourcePlan(value: unknown, current: ResourcePlan): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved resource plan");
  const { digest, ...semantic } = value as Record<string, unknown>;
  if (typeof digest !== "string" || digestValue(semantic) !== digest) throw new Error("Saved plan integrity check failed");
  if (digest !== current.digest) throw new Error("Saved plan is stale or uses different options; regenerate and review it");
}

export async function saveResourcePlan(root: string, plan: ResourcePlan): Promise<string> {
  const { digest, ...semantic } = plan;
  if (!/^[a-f0-9]{64}$/.test(digest) || digest !== digestValue(semantic)) throw new Error("Invalid resource plan digest");
  const directory = join(root, ".vibecore", "plans");
  for (const path of [join(root, ".vibecore"), directory]) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stats = await lstat(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Plan storage must be a real directory");
  }
  const path = join(directory, `${digest}.json`);
  const content = `${JSON.stringify(plan, null, 2)}\n`;
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || await readFile(path, "utf8") !== content) throw new Error("Saved plan exists with different content; refusing overwrite");
  }
  return `.vibecore/plans/${digest}.json`;
}
