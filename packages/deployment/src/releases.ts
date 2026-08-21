import { randomUUID } from "node:crypto";
import type { DeploymentConfigurationPlan, DeploymentHealthResult, DeploymentRollbackPlan, Release } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";

export function createRelease(plan: DeploymentConfigurationPlan, mode: string, now = new Date()): Release {
  const timestamp = now.toISOString();
  return { id: `release-${randomUUID()}`, application: plan.application, provider: plan.provider, mode, environment: plan.environment, sourceRevision: plan.sourceRevision, planDigest: plan.digest, status: "deploying", createdAt: timestamp, updatedAt: timestamp };
}

export async function verifyDeploymentHealth(url: string, options: { timeoutSeconds?: number; attempts?: number; intervalMs?: number; fetch?: typeof fetch } = {}): Promise<DeploymentHealthResult> {
  const target = safeHealthUrl(url);
  const attempts = integerInRange(options.attempts ?? 3, 1, 10, "Health attempts");
  const timeoutSeconds = integerInRange(options.timeoutSeconds ?? 30, 1, 300, "Health timeout");
  const intervalMs = integerInRange(options.intervalMs ?? 1000, 0, 30_000, "Health interval");
  const request = options.fetch ?? fetch;
  const started = Date.now();
  let statusCode: number | undefined;
  let errorCode = "HEALTH_REQUEST_FAILED";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await request(target, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutSeconds * 1000), headers: { accept: "application/json,text/plain,*/*", "user-agent": "vibecore-health/1" } });
      statusCode = response.status;
      if (response.ok) return { url: target, status: "healthy", checkedAt: new Date().toISOString(), attempts: attempt, statusCode, durationMs: Date.now() - started };
      errorCode = "HEALTH_HTTP_STATUS";
    } catch (error) { errorCode = healthErrorCode(error); }
    if (attempt < attempts && intervalMs > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { url: target, status: "unhealthy", checkedAt: new Date().toISOString(), attempts, ...(statusCode ? { statusCode } : {}), durationMs: Date.now() - started, errorCode };
}

export function applyHealthResult(release: Release, health: DeploymentHealthResult): Release {
  if (release.status !== "deploying") throw new Error(`Release ${release.id} is not awaiting health verification`);
  return { ...release, status: health.status, updatedAt: health.checkedAt, health };
}

export function createRollbackPlan(releases: Release[], failedReleaseId: string): DeploymentRollbackPlan {
  const failed = releases.find(({ id }) => id === failedReleaseId);
  if (!failed) throw new Error(`Unknown release: ${failedReleaseId}`);
  if (failed.status !== "unhealthy" && failed.status !== "failed") throw new Error("Rollback can only target an unhealthy or failed release");
  const target = releases.filter((candidate) => candidate.application === failed.application && candidate.environment === failed.environment && candidate.provider === failed.provider && candidate.mode === failed.mode && candidate.status === "healthy" && candidate.createdAt < failed.createdAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!target) throw new Error("No preceding healthy release is available for rollback");
  const semantic = { provider: failed.provider, mode: failed.mode, application: failed.application, environment: failed.environment, failedReleaseId: failed.id, targetReleaseId: target.id, targetSourceRevision: target.sourceRevision, strategy: rollbackStrategy(failed.provider, failed.mode) };
  return { ...semantic, digest: digestValue(semantic) };
}

export function recordRollback(releases: Release[], plan: DeploymentRollbackPlan, approval: string, now = new Date()): { failed: Release; rollback: Release } {
  if (approval !== plan.digest) throw new Error("Rollback approval does not match the generated digest");
  const { digest, ...semantic } = plan;
  if (digestValue(semantic) !== digest) throw new Error("Rollback plan was modified after generation");
  const failed = releases.find(({ id }) => id === plan.failedReleaseId);
  const target = releases.find(({ id }) => id === plan.targetReleaseId);
  if (!failed || !target || target.status !== "healthy") throw new Error("Rollback release state changed after planning");
  const timestamp = now.toISOString();
  return { failed: { ...failed, status: "rolled-back", updatedAt: timestamp }, rollback: { ...target, id: `release-${randomUUID()}`, planDigest: plan.digest, status: "deploying", createdAt: timestamp, updatedAt: timestamp, rollbackOf: failed.id } };
}

function safeHealthUrl(value: string): string { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("Health URL must be HTTP(S) without embedded credentials"); url.hash = ""; return url.toString(); }
function integerInRange(value: number, minimum: number, maximum: number, label: string): number { if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`); return value; }
function healthErrorCode(error: unknown): string { if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "HEALTH_TIMEOUT"; return "HEALTH_REQUEST_FAILED"; }
function rollbackStrategy(provider: string, mode: string): string { if (provider === "shared-hosting") return "repoint the current symlink to the preceding immutable release"; if (provider === "aws" && mode === "s3-cloudfront") return "restore the preceding versioned artifact and invalidate CloudFront"; if (provider === "digitalocean" && mode === "droplet") return "restart the preceding immutable container image digest"; return "redeploy the preceding healthy immutable source revision or image digest"; }
