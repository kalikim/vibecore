import { lstat, mkdir, readFile, rename, writeFile, unlink, rmdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { join, resolve } from "node:path";
import type {
  ActionExecutionStatus,
  DeploymentAttempt,
  Plan,
  PlanExecutionStatus,
  PlanLedgerEntry,
  Release,
  VibecoreState,
} from "@vibecore/contracts";

const emptyState = (): VibecoreState => ({
  apiVersion: "vibecore.dev/state/v1alpha1",
  plans: [],
  releases: [],
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
      parsed.releases ??= [];
      if (!Array.isArray(parsed.releases)) throw new Error("Unsupported or invalid Vibecore release ledger");
      if (parsed.deploymentAttempts !== undefined && !Array.isArray(parsed.deploymentAttempts)) throw new Error("Invalid deployment attempt ledger");
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async start(plan: Plan): Promise<void> {
    await this.mutate((state) => {
      if (state.plans.some((entry) => entry.id === plan.id && entry.status === "executing")) {
        throw new Error(`Plan is already executing: ${plan.id}`);
      }
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
    });
  }

  async startDeploymentAttempt(command: string): Promise<DeploymentAttempt> {
    // Only command names, never arguments, URLs, identifiers, tokens, or raw errors.
    if (!/^(deploy [a-z][a-z-]{0,40}|expo (build|update|submit)|reconcile)$/.test(command)) {
      throw new Error("Invalid deployment command name");
    }
    const now = new Date().toISOString();
    const attempt: DeploymentAttempt = {
      id: `attempt-${randomUUID()}`, command, status: "running", remoteOutcome: "unverified",
      createdAt: now, updatedAt: now,
    };
    await this.mutate((state) => {
      // Do not prune unresolved evidence when commands fail or a process is killed.
      state.deploymentAttempts = [...(state.deploymentAttempts ?? []), attempt];
    });
    return attempt;
  }

  async finishDeploymentAttempt(expected: DeploymentAttempt, exitCode: number): Promise<void> {
    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) throw new Error("Invalid command exit code");
    await this.mutate((state) => {
      const matches = (state.deploymentAttempts ?? []).filter(({ id }) => id === expected.id);
      if (expected.status !== "running" || matches.length !== 1 || !isDeepStrictEqual(matches[0], expected)) {
        throw new Error("Deployment attempt changed; inspect the ledger before recovery");
      }
      state.deploymentAttempts = state.deploymentAttempts!.map((entry) => entry.id === expected.id ? {
        ...entry, status: exitCode === 0 ? "command-completed" : "command-failed",
        updatedAt: new Date().toISOString(), exitCode,
      } : entry);
    });
  }

  async updateAction(
    planId: string,
    actionId: string,
    status: ActionExecutionStatus,
    errorCode?: string,
  ): Promise<void> {
    await this.mutate((state) => {
      const plan = requiredPlan(state, planId);
      const action = plan.actions.find(({ id }) => id === actionId);
      if (!action) throw new Error(`Unknown action ${actionId} in plan ${planId}`);
      action.status = status;
      if (errorCode) action.errorCode = sanitizeErrorCode(errorCode);
      plan.updatedAt = new Date().toISOString();
    });
  }

  async finish(planId: string, status: Extract<PlanExecutionStatus, "succeeded" | "failed" | "interrupted">): Promise<void> {
    await this.mutate((state) => {
      const plan = requiredPlan(state, planId);
      plan.status = status;
      plan.updatedAt = new Date().toISOString();
    });
  }

  async recordRelease(release: Release): Promise<void> {
    await this.mutate((state) => {
      if (state.releases.some(({ id }) => id === release.id)) throw new Error(`Release already exists: ${release.id}`);
      state.releases = [release, ...state.releases].slice(0, 200);
    });
  }

  async updateRelease(release: Release, expected: Release): Promise<void> {
    await this.mutate((state) => {
      const index = requireUnchangedRelease(state.releases, expected);
      assertReleaseIdentity(expected, release);
      state.releases[index] = release;
    });
  }

  async commitRollback(expected: Release[], failed: Release, rollback: Release): Promise<void> {
    await this.mutate((state) => {
      if (expected.length !== 2 || new Set(expected.map(({ id }) => id)).size !== 2) {
        throw new Error("Rollback commit requires the failed and target release snapshots");
      }
      for (const release of expected) requireUnchangedRelease(state.releases, release);
      const before = expected.find(({ id }) => id === failed.id);
      if (!before || failed.status !== "rolled-back" || rollback.rollbackOf !== failed.id) {
        throw new Error("Invalid rollback ledger replacement");
      }
      assertReleaseIdentity(before, failed);
      if (state.releases.some(({ id }) => id === rollback.id)) throw new Error(`Release already exists: ${rollback.id}`);
      state.releases = [rollback, ...state.releases.map((release) => release.id === failed.id ? failed : release)].slice(0, 200);
    });
  }

  /** Conservative repository-wide lease for CLI deployment operations, not a cloud lock. */
  async acquireDeploymentLease(): Promise<() => Promise<void>> {
    await ensureSafeDirectory(this.stateDirectory);
    const path = join(this.stateDirectory, "deployment.lock");
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      throw new Error("A deployment operation is already active or interrupted in this repository. Inspect the provider and confirm no writer is running before removing .vibecore/deployment.lock; do not retry blindly.");
    }
    let released = false;
    return async () => {
      if (released) return;
      await rmdir(path);
      released = true;
    };
  }

  /** Commit selected records together only if they still match the reviewed snapshot. */
  async compareAndSwapRecords(
    expected: Pick<VibecoreState, "plans" | "releases">,
    replacement: Pick<VibecoreState, "plans" | "releases">,
  ): Promise<void> {
    await this.mutate((state) => {
      function replace<T extends { id: string }>(current: T[], before: T[], after: T[]): T[] {
        const ids = before.map(({ id }) => id);
        if (new Set(ids).size !== ids.length || new Set(after.map(({ id }) => id)).size !== after.length ||
            after.length !== before.length || after.some(({ id }) => !ids.includes(id))) {
          throw new Error("State replacement must contain the same unique record IDs");
        }
        for (const entry of before) {
          const matches = current.filter(({ id }) => id === entry.id);
          if (matches.length !== 1 || !isDeepStrictEqual(matches[0], entry)) {
            throw new Error("State changed during reconciliation; review a new plan");
          }
        }
        return current.map((entry) => after.find(({ id }) => id === entry.id) ?? entry);
      }
      const plans = replace(state.plans, expected.plans, replacement.plans);
      const releases = replace(state.releases, expected.releases, replacement.releases);
      state.plans = plans;
      state.releases = releases;
    });
  }

  async releases(filters: Partial<Pick<Release, "application" | "environment" | "provider">> = {}): Promise<Release[]> {
    const state = await this.read();
    return state.releases.filter((release) => Object.entries(filters).every(([key, value]) => release[key as keyof typeof filters] === value));
  }

  private async write(state: VibecoreState): Promise<void> {
    await ensureSafeDirectory(this.stateDirectory);
    const temporaryPath = join(this.stateDirectory, `.state-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporaryPath, this.statePath);
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      });
    }
  }

  private async mutate(change: (state: VibecoreState) => void): Promise<void> {
    await ensureSafeDirectory(this.stateDirectory);
    const lock = join(this.stateDirectory, "state.lock");
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new Error("State ledger is locked. Retry after other Vibecore processes finish. An interrupted writer may require manual removal of .vibecore/state.lock after confirming no writer is running.");
        }
        await delay(25);
      }
    }
    try {
      const state = await this.read();
      change(state);
      await this.write(state);
    } finally {
      await rmdir(lock);
    }
  }
}

function requiredPlan(state: VibecoreState, planId: string): PlanLedgerEntry {
  const plan = state.plans.find(({ id }) => id === planId);
  if (!plan) throw new Error(`Unknown plan in state ledger: ${planId}`);
  return plan;
}

function requireUnchangedRelease(releases: Release[], expected: Release): number {
  const matches = releases.filter(({ id }) => id === expected.id);
  if (matches.length !== 1 || !isDeepStrictEqual(matches[0], expected)) {
    throw new Error("Release changed or disappeared; read the ledger and review the operation again");
  }
  return releases.findIndex(({ id }) => id === expected.id);
}

function assertReleaseIdentity(before: Release, after: Release): void {
  const identity = (value: Release) => ({
    id: value.id, application: value.application, provider: value.provider,
    mode: value.mode, environment: value.environment, sourceRevision: value.sourceRevision,
    planDigest: value.planDigest, createdAt: value.createdAt, rollbackOf: value.rollbackOf,
    providerResourceId: value.providerResourceId, providerReleaseId: value.providerReleaseId,
  });
  if (!isDeepStrictEqual(identity(before), identity(after))) throw new Error("Release identity cannot be changed by a status update");
}

async function ensureSafeDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(".vibecore must be a real directory, not a link or file");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (creationError) {
        if (!isNodeError(creationError) || creationError.code !== "EEXIST") throw creationError;
      }
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(".vibecore must be a real directory, not a link or file");
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
