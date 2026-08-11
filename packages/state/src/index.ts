import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ActionExecutionStatus,
  Plan,
  PlanExecutionStatus,
  PlanLedgerEntry,
  VibecoreState,
} from "@vibecore/contracts";

const emptyState = (): VibecoreState => ({
  apiVersion: "vibecore.dev/state/v1alpha1",
  plans: [],
});

export class FileStateStore {
  private readonly stateDirectory: string;
  private readonly statePath: string;

  constructor(repositoryRoot: string) {
    this.stateDirectory = resolve(repositoryRoot, ".vibecore");
    this.statePath = join(this.stateDirectory, "state.json");
  }

  async read(): Promise<VibecoreState> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as VibecoreState;
      if (parsed.apiVersion !== "vibecore.dev/state/v1alpha1" || !Array.isArray(parsed.plans)) {
        throw new Error("Unsupported or invalid Vibecore state file");
      }
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async start(plan: Plan): Promise<void> {
    const state = await this.read();
    const now = new Date().toISOString();
    const entry: PlanLedgerEntry = {
      id: plan.id,
      digest: plan.digest,
      environment: plan.environment,
      createdAt: plan.createdAt,
      updatedAt: now,
      status: "executing",
      actions: plan.actions.map(({ id }) => ({ id, status: "pending" })),
    };
    state.plans = [entry, ...state.plans.filter(({ id }) => id !== plan.id)].slice(0, 100);
    await this.write(state);
  }

  async updateAction(
    planId: string,
    actionId: string,
    status: ActionExecutionStatus,
    errorCode?: string,
  ): Promise<void> {
    const state = await this.read();
    const plan = requiredPlan(state, planId);
    const action = plan.actions.find(({ id }) => id === actionId);
    if (!action) throw new Error(`Unknown action ${actionId} in plan ${planId}`);
    action.status = status;
    if (errorCode) action.errorCode = sanitizeErrorCode(errorCode);
    plan.updatedAt = new Date().toISOString();
    await this.write(state);
  }

  async finish(planId: string, status: Extract<PlanExecutionStatus, "succeeded" | "failed" | "interrupted">): Promise<void> {
    const state = await this.read();
    const plan = requiredPlan(state, planId);
    plan.status = status;
    plan.updatedAt = new Date().toISOString();
    await this.write(state);
  }

  private async write(state: VibecoreState): Promise<void> {
    await ensureSafeDirectory(this.stateDirectory);
    const temporaryPath = join(this.stateDirectory, `.state-${process.pid}-${Date.now()}.tmp`);
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, this.statePath);
  }
}

function requiredPlan(state: VibecoreState, planId: string): PlanLedgerEntry {
  const plan = state.plans.find(({ id }) => id === planId);
  if (!plan) throw new Error(`Unknown plan in state ledger: ${planId}`);
  return plan;
}

async function ensureSafeDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(".vibecore must be a real directory, not a link or file");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await mkdir(path, { mode: 0o700 });
      return;
    }
    throw error;
  }
}

function sanitizeErrorCode(value: string): string {
  return /^[A-Z][A-Z0-9_.-]{0,79}$/.test(value) ? value : "EXECUTION_ERROR";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
