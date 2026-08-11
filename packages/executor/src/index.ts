import { writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Plan } from "@vibecore/contracts";
import type { ManifestWriteInput } from "@vibecore/planner";
import { verifyPlanDigest } from "@vibecore/planner";

export interface ExecutionResult {
  planId: string;
  status: "succeeded";
  appliedActions: string[];
}

export async function applyAdoptionPlan(
  plan: Plan,
  options: {
    repositoryRoot: string;
    approval: string;
    currentRepositoryFingerprint: string;
  },
): Promise<ExecutionResult> {
  if (!verifyPlanDigest(plan)) throw new Error("Plan digest is invalid; regenerate the plan");
  if (options.approval !== plan.digest) throw new Error("Approval digest does not match the plan");
  if (options.currentRepositoryFingerprint !== plan.repositoryFingerprint) {
    throw new Error("Repository inputs changed after planning; regenerate the plan");
  }

  const appliedActions: string[] = [];
  for (const action of plan.actions) {
    if (action.operation !== "manifest.create") {
      throw new Error(`Unsupported action operation: ${action.operation}`);
    }
    const input = action.inputs as ManifestWriteInput;
    const target = safeTarget(options.repositoryRoot, input.path);
    try {
      await writeFile(target, input.content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new Error(`${input.path} already exists; adoption will not overwrite it`);
      }
      throw error;
    }
    appliedActions.push(action.id);
  }

  return { planId: plan.id, status: "succeeded", appliedActions };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function safeTarget(repositoryRoot: string, requestedPath: string): string {
  if (isAbsolute(requestedPath)) throw new Error("Plan target must be repository-relative");
  const root = resolve(repositoryRoot);
  const target = resolve(root, requestedPath);
  const pathFromRoot = relative(root, target);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..")) {
    throw new Error("Plan target escapes the repository root");
  }
  return target;
}
