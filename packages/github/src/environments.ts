import { spawn } from "node:child_process";
import { digestValue } from "@vibecore/planner";
import type { VibecoreManifest } from "@vibecore/contracts";

export interface GitHubEnvironmentPlanItem { name: "dev" | "staging" | "production"; production: boolean; secretNames: string[]; body: Record<string, unknown>; }
export interface GitHubEnvironmentPlan { repository: string; digest: string; environments: GitHubEnvironmentPlanItem[]; apiVersion: "2026-03-10"; }
export interface GitHubEnvironmentClient { putEnvironment(repository: string, environment: string, body: Record<string, unknown>): Promise<void>; }

export function createGitHubEnvironmentPlan(manifest: VibecoreManifest, repository: string): GitHubEnvironmentPlan {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub repository must use owner/name format");
  const secretNames = Object.entries(manifest.variables ?? {}).filter(([, value]) => value.secret).map(([name]) => name).sort();
  const environments: GitHubEnvironmentPlanItem[] = [
    { name: "dev", production: false, secretNames, body: { deployment_branch_policy: null } },
    { name: "staging", production: false, secretNames, body: { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } } },
    { name: "production", production: true, secretNames, body: { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } } },
  ];
  for (const item of environments) if (!manifest.environments[item.name]) throw new Error(`Manifest does not declare ${item.name}`);
  const semantic = { repository, environments, apiVersion: "2026-03-10" as const };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function applyGitHubEnvironmentPlan(plan: GitHubEnvironmentPlan, approval: string, productionApproved: boolean, client: GitHubEnvironmentClient = new GhEnvironmentClient()): Promise<string[]> {
  if (approval !== plan.digest) throw new Error("GitHub environment approval does not match the generated digest");
  if (digestValue({ repository: plan.repository, environments: plan.environments, apiVersion: plan.apiVersion }) !== plan.digest) throw new Error("GitHub environment plan was modified after generation");
  if (!productionApproved) throw new Error("Remote production environment configuration requires explicit production approval");
  const applied: string[] = [];
  for (const environment of plan.environments) { await client.putEnvironment(plan.repository, environment.name, environment.body); applied.push(environment.name); }
  return applied;
}

export class GhEnvironmentClient implements GitHubEnvironmentClient {
  async putEnvironment(repository: string, environment: string, body: Record<string, unknown>): Promise<void> {
    await runGh(["api", "--method", "PUT", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10", `repos/${repository}/environments/${encodeURIComponent(environment)}`, "--input", "-"], JSON.stringify(body));
  }
}

async function runGh(args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("gh", args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`GitHub API request failed${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).at(-1)}` : ""}`)));
    child.stdin.end(input);
  });
}
