import type { PlanLedgerEntry, Release, VibecoreState } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
import { applyHealthResult, verifyDeploymentHealth } from "./releases.js";

export interface ReconciliationPlan {
  action: "reconcile-interrupted";
  planIds: string[];
  releaseIds: string[];
  stateDigest: string;
  digest: string;
}

export function createReconciliationPlan(state: VibecoreState): ReconciliationPlan {
  const planIds = state.plans.filter((plan) => plan.status === "executing").map((plan) => plan.id).sort();
  const releaseIds = state.releases.filter((release) => release.status === "deploying").map((release) => release.id).sort();
  if (planIds.length === 0 && releaseIds.length === 0) throw new Error("No interrupted plans or deploying releases to reconcile");
  const stateDigest = selectedStateDigest(state, planIds, releaseIds);
  const semantic = { action: "reconcile-interrupted" as const, planIds, releaseIds, stateDigest };
  return { ...semantic, digest: digestValue(semantic) };
}

export function applyReconciliationPlan(
  state: VibecoreState,
  plan: ReconciliationPlan,
  approval: string,
  now = new Date(),
): { plans: PlanLedgerEntry[]; releases: Release[] } {
  verify(plan, approval);
  if (selectedStateDigest(state, plan.planIds, plan.releaseIds) !== plan.stateDigest) {
    throw new Error("Reconciliation target state changed after planning; review a new plan");
  }
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
  const approvedReleaseIds = new Set(plan.releaseIds);
  const releases: Release[] = [];
  for (const release of next.releases) {
    const original = state.releases.find((candidate) => candidate.id === release.id);
    if (approvedReleaseIds.has(release.id) && original?.status === "deploying" && original.health?.url) {
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

function selectedStateDigest(state: VibecoreState, planIds: string[], releaseIds: string[]): string {
  function select<T extends { id: string }>(entries: T[], ids: string[]): T[] {
    if (new Set(ids).size !== ids.length) throw new Error("Reconciliation contains duplicate target IDs");
    return [...ids].sort().map((id) => {
      const matches = entries.filter((entry) => entry.id === id);
      if (matches.length !== 1) throw new Error(`Reconciliation target ${id} is missing or duplicated`);
      return matches[0]!;
    });
  }
  return digestValue({ plans: select(state.plans, planIds), releases: select(state.releases, releaseIds) });
}
