import { spawn } from "node:child_process";
import type { Diagnostic, VibecoreManifest } from "@vibecore/contracts";

export interface RemoteGitHubEnvironment {
  name: string;
  protectedBranches: boolean;
  protectionRules: string[];
}

export interface GitHubAuditClient {
  listEnvironments(repository: string): Promise<RemoteGitHubEnvironment[]>;
  listEnvironmentSecretNames(repository: string, environment: string): Promise<string[]>;
}

export interface GitHubEnvironmentAudit {
  repository: string;
  environments: Array<{ name: string; exists: boolean; requiredSecretNames: string[]; configuredSecretNames: string[]; protectedBranches: boolean }>;
  diagnostics: Diagnostic[];
}

export async function auditGitHubEnvironments(manifest: VibecoreManifest, repository: string, client: GitHubAuditClient = new GhAuditClient()): Promise<GitHubEnvironmentAudit> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub repository must use owner/name format");
  const remote = await client.listEnvironments(repository);
  const requiredSecrets = Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret).map(([name]) => name).sort();
  const diagnostics: Diagnostic[] = [];
  const environments = [];
  for (const name of ["dev", "staging", "production"]) {
    const found = remote.find((environment) => environment.name.toLowerCase() === name);
    if (!found) {
      diagnostics.push(diag("github.environment.missing", "error", name, `GitHub environment ${name} is missing`));
      environments.push({ name, exists: false, requiredSecretNames: requiredSecrets, configuredSecretNames: [], protectedBranches: false });
      continue;
    }
    const configured = (await client.listEnvironmentSecretNames(repository, found.name)).sort();
    for (const secret of requiredSecrets) if (!configured.includes(secret)) diagnostics.push(diag("github.environment.secret_missing", "error", name, `${name} is missing required secret ${secret}`));
    for (const secret of configured) if (!requiredSecrets.includes(secret)) diagnostics.push(diag("github.environment.secret_unexpected", "warning", name, `${name} contains undeclared secret ${secret}`));
    if ((name === "staging" || name === "production") && !found.protectedBranches) diagnostics.push(diag("github.environment.branch_policy_missing", "error", name, `${name} does not require protected deployment branches`));
    if (name === "production" && !found.protectionRules.includes("required_reviewers")) diagnostics.push(diag("github.environment.reviewers_missing", "warning", name, "Production has no required reviewer protection rule"));
    environments.push({ name, exists: true, requiredSecretNames: requiredSecrets, configuredSecretNames: configured, protectedBranches: found.protectedBranches });
  }
  return { repository, environments, diagnostics };
}

export class GhAuditClient implements GitHubAuditClient {
  async listEnvironments(repository: string): Promise<RemoteGitHubEnvironment[]> {
    const value = await ghJson(`repos/${repository}/environments?per_page=100`);
    if (!isRecord(value) || !Array.isArray(value.environments)) throw new Error("GitHub environments response is invalid");
    return value.environments.flatMap((item) => {
      if (!isRecord(item) || typeof item.name !== "string") return [];
      const branch = isRecord(item.deployment_branch_policy) && item.deployment_branch_policy.protected_branches === true;
      const rules = Array.isArray(item.protection_rules) ? item.protection_rules.flatMap((rule) => isRecord(rule) && typeof rule.type === "string" ? [rule.type] : []) : [];
      return [{ name: item.name, protectedBranches: branch, protectionRules: rules }];
    });
  }

  async listEnvironmentSecretNames(repository: string, environment: string): Promise<string[]> {
    const value = await ghJson(`repos/${repository}/environments/${encodeURIComponent(environment)}/secrets?per_page=100`);
    if (!isRecord(value) || !Array.isArray(value.secrets)) throw new Error("GitHub environment secrets response is invalid");
    return value.secrets.flatMap((secret) => isRecord(secret) && typeof secret.name === "string" ? [secret.name] : []);
  }
}

async function ghJson(endpoint: string): Promise<unknown> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("gh", ["api", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10", endpoint], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${String(chunk)}`; });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4000); });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`GitHub API read failed${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).at(-1)}` : ""}`)));
  });
  return JSON.parse(output) as unknown;
}

function diag(code: string, severity: Diagnostic["severity"], component: string, message: string): Diagnostic { return { code, severity, component, message }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
