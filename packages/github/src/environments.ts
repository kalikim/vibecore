import { spawn } from "node:child_process";
import { digestValue } from "@vibecore/planner";
import type { VibecoreManifest } from "@vibecore/contracts";

export interface GitHubEnvironmentPlanItem { name: "dev" | "staging" | "production"; production: boolean; secretNames: string[]; body: Record<string, unknown>; }
export interface GitHubEnvironmentPlan { repository: string; digest: string; environments: GitHubEnvironmentPlanItem[]; productionReviewers: string[]; apiVersion: "2026-03-10"; }
export interface GitHubEnvironmentClient {
  putEnvironment(repository: string, environment: string, body: Record<string, unknown>): Promise<void>;
  resolveUserId(login: string): Promise<number>;
}

export function createGitHubEnvironmentPlan(manifest: VibecoreManifest, repository: string, productionReviewers: string[] = []): GitHubEnvironmentPlan {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub repository must use owner/name format");
  const reviewers = uniqueLogins(productionReviewers);
  const secretNames = Object.entries(manifest.variables ?? {}).filter(([, value]) => value.secret).map(([name]) => name).sort();
  const environments: GitHubEnvironmentPlanItem[] = [
    { name: "dev", production: false, secretNames, body: { deployment_branch_policy: null } },
    { name: "staging", production: false, secretNames, body: { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } } },
    { name: "production", production: true, secretNames, body: { deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }, prevent_self_review: true } },
  ];
  for (const item of environments) if (!manifest.environments[item.name]) throw new Error(`Manifest does not declare ${item.name}`);
  const semantic = { repository, environments, productionReviewers: reviewers, apiVersion: "2026-03-10" as const };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function applyGitHubEnvironmentPlan(plan: GitHubEnvironmentPlan, approval: string, productionApproved: boolean, client: GitHubEnvironmentClient = new GhEnvironmentClient()): Promise<string[]> {
  if (approval !== plan.digest) throw new Error("GitHub environment approval does not match the generated digest");
  if (digestValue({ repository: plan.repository, environments: plan.environments, productionReviewers: plan.productionReviewers, apiVersion: plan.apiVersion }) !== plan.digest) throw new Error("GitHub environment plan was modified after generation");
  if (!productionApproved) throw new Error("Remote production environment configuration requires explicit production approval");
  const reviewers = plan.productionReviewers.length
    ? await Promise.all(plan.productionReviewers.map(async (login) => ({ type: "User", id: await client.resolveUserId(login) })))
    : [];
  const applied: string[] = [];
  for (const environment of plan.environments) {
    const body = environment.name === "production" && reviewers.length ? { ...environment.body, reviewers } : environment.body;
    await client.putEnvironment(plan.repository, environment.name, body);
    applied.push(environment.name);
  }
  return applied;
}

export class GhEnvironmentClient implements GitHubEnvironmentClient {
  async putEnvironment(repository: string, environment: string, body: Record<string, unknown>): Promise<void> {
    await runGh(["api", "--method", "PUT", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10", `repos/${repository}/environments/${encodeURIComponent(environment)}`, "--input", "-"], JSON.stringify(body));
  }
  async resolveUserId(login: string): Promise<number> {
    const output = await runGhCapture(["api", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10", `users/${encodeURIComponent(login)}`]);
    const parsed = JSON.parse(output) as { id?: unknown };
    if (!Number.isInteger(parsed.id) || (parsed.id as number) <= 0) throw new Error(`GitHub user ${login} could not be resolved`);
    return parsed.id as number;
  }
}

function uniqueLogins(values: string[]): string[] {
  const logins = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  for (const login of logins) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) throw new Error(`GitHub reviewer ${JSON.stringify(login)} is not a safe username`);
  }
  return logins.sort((left, right) => left.localeCompare(right));
}

async function runGh(args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("gh", args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`GitHub API request failed${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).at(-1)}` : ""}`)));
    child.stdin.end(input);
  });
}

async function runGhCapture(args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("gh", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`GitHub API request failed${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).at(-1)}` : ""}`)));
  });
}
