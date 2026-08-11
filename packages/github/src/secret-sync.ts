import { spawn } from "node:child_process";
import type { VibecoreManifest } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";

export interface GitHubSecretSyncPlan { repository: string; environment: "dev" | "staging" | "production"; secretNames: string[]; digest: string; }
export interface GitHubSecretClient { setEnvironmentSecret(repository: string, environment: string, name: string, value: string): Promise<void>; }

export function createGitHubSecretSyncPlan(manifest: VibecoreManifest, repository: string, environment: string): GitHubSecretSyncPlan {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub repository must use owner/name format");
  if (environment !== "dev" && environment !== "staging" && environment !== "production") throw new Error("GitHub secret target must be dev, staging, or production");
  if (!manifest.environments[environment]) throw new Error(`Manifest does not declare ${environment}`);
  const targetEnvironment: GitHubSecretSyncPlan["environment"] = environment;
  const secretNames = Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret).map(([name]) => name).sort();
  const semantic = { repository, environment: targetEnvironment, secretNames };
  return { ...semantic, digest: digestValue(semantic) };
}

export async function applyGitHubSecretSyncPlan(plan: GitHubSecretSyncPlan, approval: string, values: NodeJS.ProcessEnv, productionApproved: boolean, client: GitHubSecretClient = new GhSecretClient()): Promise<string[]> {
  if (approval !== plan.digest) throw new Error("GitHub secret approval does not match the generated digest");
  if (digestValue({ repository: plan.repository, environment: plan.environment, secretNames: plan.secretNames }) !== plan.digest) throw new Error("GitHub secret plan was modified after generation");
  if (plan.environment === "production" && !productionApproved) throw new Error("Production secret synchronization requires explicit production approval");
  const missing = plan.secretNames.filter((name) => !values[name]);
  if (missing.length) throw new Error(`Secret values are missing from the execution environment: ${missing.join(", ")}`);
  const applied: string[] = [];
  for (const name of plan.secretNames) { await client.setEnvironmentSecret(plan.repository, plan.environment, name, values[name]!); applied.push(name); }
  return applied;
}

export class GhSecretClient implements GitHubSecretClient {
  async setEnvironmentSecret(repository: string, environment: string, name: string, value: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("gh", ["secret", "set", name, "--repo", repository, "--env", environment], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
      let stderr = ""; child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
      child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`GitHub secret update failed for ${name}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).at(-1)}` : ""}`)));
      child.stdin.end(value);
    });
  }
}
