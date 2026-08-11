import { writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Plan } from "@vibecore/contracts";
import type { ManifestWriteInput } from "@vibecore/planner";
import { verifyPlanDigest } from "@vibecore/planner";
import { evaluatePlan } from "@vibecore/policy";
import { FileStateStore } from "@vibecore/state";

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
    productionApproved?: boolean;
    stateStore?: FileStateStore;
  },
): Promise<ExecutionResult> {
  if (!verifyPlanDigest(plan)) throw new Error("Plan digest is invalid; regenerate the plan");
  if (options.currentRepositoryFingerprint !== plan.repositoryFingerprint) {
    throw new Error("Repository inputs changed after planning; regenerate the plan");
  }

  const policy = evaluatePlan(plan, {
    approval: options.approval,
    ...(options.productionApproved !== undefined
      ? { productionApproved: options.productionApproved }
      : {}),
  });
  if (!policy.allowed) {
    const reasons = policy.decisions
      .filter(({ effect }) => effect !== "allow")
      .map(({ code }) => code)
      .join(", ");
    throw new Error(`Plan denied by policy: ${reasons}`);
  }

  const stateStore = options.stateStore ?? new FileStateStore(options.repositoryRoot);
  const appliedActions: string[] = [];
  await stateStore.start(plan);
  try {
    for (const action of plan.actions) {
      await stateStore.updateAction(plan.id, action.id, "executing");
      try {
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
        await stateStore.updateAction(plan.id, action.id, "succeeded");
      } catch (error) {
        await stateStore.updateAction(plan.id, action.id, "failed", errorCode(error));
        throw error;
      }
    }
    await stateStore.finish(plan.id, "succeeded");
  } catch (error) {
    await stateStore.finish(plan.id, "failed");
    throw error;
  }

  return { planId: plan.id, status: "succeeded", appliedActions };
}

function errorCode(error: unknown): string {
  if (isNodeError(error) && typeof error.code === "string") return error.code;
  return "EXECUTION_ERROR";
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
