import type { DeploymentHealthResult, PlanLedgerEntry, Release, VibecoreState } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
import { applyHealthResult, verifyDeploymentHealth } from "./releases.js";

export interface ReconciliationPlan {
  action: "reconcile-interrupted";
  planIds: string[];
  releaseIds: string[];
  digest: string;
}

export function createReconciliationPlan(state: VibecoreState): ReconciliationPlan {
  const planIds = state.plans.filter((plan) => plan.status === "executing").map((plan) => plan.id).sort();
  const releaseIds = state.releases.filter((release) => release.status === "deploying").map((release) => release.id).sort();
  if (planIds.length === 0 && releaseIds.length === 0) throw new Error("No interrupted plans or deploying releases to reconcile");
  const semantic = { action: "reconcile-interrupted" as const, planIds, releaseIds };
  return { ...semantic, digest: digestValue(semantic) };
}

export function applyReconciliationPlan(
  state: VibecoreState,
  plan: ReconciliationPlan,
  approval: string,
  now = new Date(),
): { plans: PlanLedgerEntry[]; releases: Release[] } {
  verify(plan, approval);
  const timestamp = now.toISOString();
  const planIds = new Set(plan.planIds);
  const releaseIds = new Set(plan.releaseIds);
  const plans = state.plans.map((entry) => {
    if (!planIds.has(entry.id)) return entry;
    if (entry.status !== "executing") throw new Error(`Plan ${entry.id} is no longer executing`);
    return { ...entry, status: "interrupted" as const, updatedAt: timestamp };
  });
  const releases = state.releases.map((release) => {
    if (!releaseIds.has(release.id)) return release;
    if (release.status !== "deploying") throw new Error(`Release ${release.id} is no longer deploying`);
    return { ...release, status: "failed" as const, updatedAt: timestamp };
  });
  return { plans, releases };
}

export async function recheckDeployingRelease(release: Release, options: { fetch?: typeof fetch; now?: Date } = {}): Promise<Release> {
  if (release.status !== "deploying") throw new Error(`Release ${release.id} is no longer deploying`);
  const url = release.health?.url;
  if (!url) return { ...release, status: "failed", updatedAt: (options.now ?? new Date()).toISOString() };
  const health = await verifyDeploymentHealth(url, { attempts: 3, timeoutSeconds: 10, intervalMs: 0, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return applyHealthResult(release, health);
}

export async function applyReconciliationWithHealth(
  state: VibecoreState,
  plan: ReconciliationPlan,
  approval: string,
  options: { fetch?: typeof fetch; now?: Date } = {},
): Promise<{ plans: PlanLedgerEntry[]; releases: Release[] }> {
  const next = applyReconciliationPlan(state, plan, approval, options.now);
  const releases: Release[] = [];
  for (const release of next.releases) {
    const original = state.releases.find((candidate) => candidate.id === release.id);
    if (original?.status === "deploying" && original.health?.url) {
      releases.push(await recheckDeployingRelease(original, options));
    } else {
      releases.push(release);
    }
  }
  return { plans: next.plans, releases };
}

function verify(plan: ReconciliationPlan, approval: string): void {
  const { digest, ...semantic } = plan;
  if (approval !== digest) throw new Error("Reconciliation approval does not match the generated digest");
  if (digestValue(semantic) !== digest) throw new Error("Reconciliation plan was modified after generation");
}
