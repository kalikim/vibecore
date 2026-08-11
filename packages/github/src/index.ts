import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { stringify } from "yaml";
import type { VibecoreManifest } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
export * from "./environments.js";
export * from "./audit.js";

export interface GitHubGeneratedFile { path: string; content: string; }
export interface GitHubSetupPlan { digest: string; files: GitHubGeneratedFile[]; environments: string[]; secretNames: Record<string, string[]>; warnings: string[]; }

const checkoutRevision = "11bd71901bbe5b1630ceea73d27597364c9af683";

export function createGitHubSetupPlan(manifest: VibecoreManifest): GitHubSetupPlan {
  const environments = ["dev", "staging", "production"];
  const missing = environments.filter((name) => !manifest.environments[name]);
  if (missing.length) throw new Error(`Manifest must declare standard environments: ${missing.join(", ")}`);
  if (!manifest.environments.production?.production) throw new Error("The production environment must set production: true");
  const secretNames = Object.fromEntries(environments.map((environment) => [environment, Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret).map(([name]) => name).sort()]));
  const files = [
    { path: ".github/workflows/ci.yml", content: workflowYaml(ciWorkflow()) },
    { path: ".github/workflows/deploy.yml", content: workflowYaml(deployWorkflow(secretNames.production ?? [])) },
    { path: ".github/dependabot.yml", content: workflowYaml(dependabotConfig()) },
  ];
  const semantic = { files, environments, secretNames };
  return {
    digest: digestValue(semantic), files, environments, secretNames,
    warnings: ["Configure required reviewers and prevent self-review for the GitHub production environment.", "Deployment jobs are validation gates until a deployment adapter is configured."],
  };
}

export async function applyGitHubSetupPlan(root: string, plan: GitHubSetupPlan, approval: string): Promise<string[]> {
  if (approval !== plan.digest) throw new Error("GitHub setup approval does not match the generated digest");
  if (digestValue({ files: plan.files, environments: plan.environments, secretNames: plan.secretNames }) !== plan.digest) throw new Error("GitHub setup plan was modified after generation");
  const targets = plan.files.map((file) => ({ ...file, absolute: safeTarget(root, file.path) }));
  for (const target of targets) {
    try { await access(target.absolute); throw new Error(`${target.path} already exists; GitHub setup will not overwrite it`); } catch (error) { if (error instanceof Error && !messageIsMissing(error)) throw error; }
  }
  for (const target of targets) { await mkdir(dirname(target.absolute), { recursive: true }); await writeFile(target.absolute, target.content, { flag: "wx", mode: 0o644 }); }
  return targets.map(({ path }) => path);
}

function ciWorkflow(): Record<string, unknown> {
  return {
    name: "Vibecore CI",
    on: { pull_request: { branches: ["main"] }, push: { branches: ["main"] } },
    permissions: { contents: "read" },
    concurrency: { group: "ci-${{ github.workflow }}-${{ github.ref }}", "cancel-in-progress": true },
    jobs: { validate: { "timeout-minutes": 20, "runs-on": "ubuntu-latest", steps: [
      { uses: `actions/checkout@${checkoutRevision}`, with: { "persist-credentials": false } },
      { name: "Enable Corepack", run: "corepack enable" },
      { name: "Install locked dependencies", run: "pnpm install --frozen-lockfile", env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } },
      { name: "Typecheck and test", run: "pnpm check" },
      { name: "Validate manifest", run: "pnpm exec vibe doctor --environment dev" },
    ] } },
  };
}

function deployWorkflow(secretNames: string[]): Record<string, unknown> {
  return {
    name: "Vibecore deployment gate",
    on: { workflow_dispatch: { inputs: { environment: { description: "Target environment", required: true, type: "choice", options: ["dev", "staging", "production"] } } } },
    permissions: { contents: "read" },
    concurrency: { group: "deploy-${{ inputs.environment }}", "cancel-in-progress": false },
    jobs: { gate: { environment: "${{ inputs.environment }}", "timeout-minutes": 20, "runs-on": "ubuntu-latest", env: Object.fromEntries(secretNames.map((name) => [name, `\${{ secrets.${name} }}`])), steps: [
      { uses: `actions/checkout@${checkoutRevision}`, with: { "persist-credentials": false } },
      { name: "Enable Corepack", run: "corepack enable" },
      { name: "Install locked dependencies", run: "pnpm install --frozen-lockfile", env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" } },
      { name: "Validate target environment", run: "pnpm exec vibe doctor --environment ${{ inputs.environment }}" },
      { name: "Run project checks", run: "pnpm check" },
      { name: "Deployment adapter required", run: "echo 'Validation passed. Configure a Vibecore deployment adapter before shipping.'" },
    ] } },
  };
}

function dependabotConfig(): Record<string, unknown> { return { version: 2, updates: [{ "package-ecosystem": "npm", directory: "/", schedule: { interval: "weekly" }, "open-pull-requests-limit": 5 }, { "package-ecosystem": "github-actions", directory: "/", schedule: { interval: "weekly" }, "open-pull-requests-limit": 5 }] }; }
function workflowYaml(value: unknown): string { return stringify(value, { lineWidth: 0 }); }
function safeTarget(root: string, path: string): string { if (isAbsolute(path)) throw new Error("GitHub target must be repository-relative"); const target = resolve(root, path); const rel = relative(resolve(root), target); if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("GitHub target escapes the repository"); return target; }
function messageIsMissing(error: Error): boolean { return "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"; }
