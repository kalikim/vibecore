import type { Diagnostic } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";

export interface HostedDatabaseInspection {
  provider: string;
  projectId?: string;
  name?: string;
  region?: string;
  diagnostics: Diagnostic[];
}

export interface NeonBranchPlan {
  provider: "neon";
  operation: "branch";
  projectId: string;
  branchName: string;
  environment: string;
  requiredSecretNames: string[];
  digest: string;
}

export interface NeonBranchResult {
  provider: "neon";
  projectId: string;
  branchId: string;
  branchName: string;
}

export async function inspectHostedDatabase(
  provider: string,
  environment: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): Promise<HostedDatabaseInspection> {
  const id = provider.toLowerCase() === "atlas" ? "mongodb-atlas" : provider.toLowerCase();
  if (id === "neon") return inspectNeon(environment, request);
  throw new Error(`Authenticated inspect is implemented for neon; ${provider} still uses vibe db doctor for environment-contract checks`);
}

export function createNeonBranchPlan(options: { projectId?: string; branchName: string; environment: string; environmentVariables?: NodeJS.ProcessEnv }): NeonBranchPlan {
  const projectId = safeProjectId(options.projectId ?? options.environmentVariables?.NEON_PROJECT_ID ?? "");
  const branchName = safeBranchName(options.branchName);
  if (!options.environment || !/^[a-z][a-z0-9-]{0,31}$/.test(options.environment)) throw new Error("Branch environment name is unsafe");
  const semantic = { provider: "neon" as const, operation: "branch" as const, projectId, branchName, environment: options.environment, requiredSecretNames: ["NEON_API_KEY"] };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function executeNeonBranchPlan(plan: NeonBranchPlan, options: {
  approval: string;
  token: string;
  productionApproved?: boolean;
  request?: typeof fetch;
}): Promise<NeonBranchResult> {
  const { digest, ...semantic } = plan;
  if (options.approval !== digest) throw new Error("Neon branch approval does not match the generated digest");
  if (digestValue(semantic) !== digest) throw new Error("Neon branch plan was modified after generation");
  if (plan.environment === "production") throw new Error("Neon branch creation refuses the production environment; branch an existing non-production project instead");
  if (!options.token || /\s/.test(options.token)) throw new Error("NEON_API_KEY must be supplied through the execution environment");
  const response = await (options.request ?? fetch)(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(plan.projectId)}/branches`, {
    method: "POST",
    redirect: "error",
    headers: { accept: "application/json", authorization: `Bearer ${options.token}`, "content-type": "application/json" },
    body: JSON.stringify({ branch: { name: plan.branchName } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Neon branch create failed with HTTP ${response.status}`);
  const payload = await response.json() as { branch?: { id?: unknown; name?: unknown }; endpoints?: unknown };
  const branchId = typeof payload.branch?.id === "string" ? payload.branch.id : "";
  const branchName = typeof payload.branch?.name === "string" ? payload.branch.name : plan.branchName;
  if (!branchId) throw new Error("Neon did not return a branch id");
  const result: NeonBranchResult = { provider: "neon", projectId: plan.projectId, branchId, branchName };
  const serialized = JSON.stringify(result);
  if (serialized.includes(options.token) || serialized.includes("postgres://") || serialized.includes("postgresql://")) throw new Error("Neon branch result refused to include a secret or connection URI");
  return result;
}

async function inspectNeon(environment: NodeJS.ProcessEnv, request: typeof fetch): Promise<HostedDatabaseInspection> {
  const token = environment.NEON_API_KEY;
  const projectId = environment.NEON_PROJECT_ID;
  if (!token || /\s/.test(token)) throw new Error("NEON_API_KEY must be supplied through the execution environment");
  if (!projectId || !/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) throw new Error("NEON_PROJECT_ID must be a safe project identifier");
  const response = await request(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}`, {
    method: "GET",
    redirect: "error",
    headers: { accept: "application/json", authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Neon project inspect failed with HTTP ${response.status}`);
  const payload = await response.json() as { project?: Record<string, unknown> };
  const project = payload.project ?? payload as Record<string, unknown>;
  const inspection: HostedDatabaseInspection = {
    provider: "neon",
    ...(typeof project.id === "string" ? { projectId: project.id } : { projectId }),
    ...(typeof project.name === "string" ? { name: project.name } : {}),
    ...(typeof project.region_id === "string" ? { region: project.region_id } : {}),
    diagnostics: [{
      code: "database.neon.project_inspected",
      severity: "info",
      component: "neon",
      message: "Neon project metadata was read; connection URIs were not requested.",
    }],
  };
  if (JSON.stringify(inspection).includes(token)) throw new Error("Neon inspect refused to return a secret value");
  return inspection;
}

function safeProjectId(value: string): string {
  if (!value || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("NEON_PROJECT_ID must be a safe project identifier");
  return value;
}

function safeBranchName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new Error("Neon branch name must be a lowercase DNS label");
  return value;
}
