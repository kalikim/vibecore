import { createHash } from "node:crypto";
import { stringify } from "yaml";
import type { Action, Plan, RepositoryScan, VibecoreManifest } from "@vibecore/contracts";

export interface ManifestWriteInput {
  path: string;
  content: string;
  expectedAbsent: true;
}

export function createAdoptionPlan(
  scan: RepositoryScan,
  manifest: VibecoreManifest,
  manifestPath = "vibecore.yaml",
): Plan {
  const input: ManifestWriteInput = {
    path: manifestPath,
    content: stringify(manifest, { lineWidth: 100 }),
    expectedAbsent: true,
  };
  const action: Action = {
    id: "manifest.create",
    adapter: "vibecore.config",
    operation: "manifest.create",
    summary: `Create ${manifestPath} from detected repository state`,
    risk: "write",
    dependsOn: [],
    inputs: input,
    permissions: [
      { kind: "filesystem", target: manifestPath, access: "write" },
      { kind: "filesystem", target: ".vibecore/state.json", access: "write" },
    ],
  };
  const semanticPlan = {
    apiVersion: "vibecore.dev/plan/v1alpha1" as const,
    repositoryFingerprint: scan.fingerprint,
    environment: "dev",
    actions: [action],
  };
  const digest = digestValue(semanticPlan);

  return {
    ...semanticPlan,
    id: `plan-${digest.slice(0, 12)}`,
    digest,
    createdAt: new Date().toISOString(),
  };
}

export function verifyPlanDigest(plan: Plan): boolean {
  return plan.digest === digestValue({
    apiVersion: plan.apiVersion,
    repositoryFingerprint: plan.repositoryFingerprint,
    environment: plan.environment,
    actions: plan.actions,
  });
}

export function digestValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}
