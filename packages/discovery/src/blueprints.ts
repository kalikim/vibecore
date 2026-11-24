import type { VibecoreManifest } from "@codexsafari/vibecore-contracts";

export interface BlueprintSummary {
  id: string;
  displayName: string;
  description: string;
}

const blueprints: Record<string, { summary: BlueprintSummary; build: (projectName: string) => VibecoreManifest }> = {
  reference: {
    summary: {
      id: "reference",
      displayName: "Reference web, API, and Expo stack",
      description: "pnpm workspace with Next.js, Hono, Expo, and PostgreSQL/Prisma. Writes a manifest only; it does not generate application source.",
    },
    build: (projectName) => ({
      apiVersion: "vibecore.dev/v1alpha1",
      kind: "Application",
      metadata: { name: projectName, description: "Reference web, API, and Expo application" },
      workspace: { packageManager: "pnpm" },
      applications: {
        web: { type: "web", framework: "next", path: "apps/web", dependsOn: ["api"], health: { path: "/api/health" } },
        api: { type: "api", framework: "hono", path: "apps/api", dependsOn: ["database"], health: { path: "/health" } },
        mobile: { type: "mobile", framework: "expo", path: "apps/mobile", dependsOn: ["api"] },
      },
      resources: { database: { type: "sql", provider: "postgres", config: { orm: "prisma" } } },
      variables: {
        DATABASE_URL: { required: true, secret: true, applications: ["api"] },
        EXPO_PUBLIC_API_URL: { required: true, applications: ["mobile"] },
      },
      environments: {
        dev: { runtime: "docker-compose", variableSources: { default: "env-file" } },
        staging: { runtime: "github-actions", variableSources: { default: "github-environment" } },
        production: { runtime: "github-actions", production: true, variableSources: { default: "github-environment" } },
      },
      policies: { requirePlan: true, requireProductionApproval: true, requireBackupForDestructiveMigration: true },
    }),
  },
  "web-api": {
    summary: {
      id: "web-api",
      displayName: "Web and API",
      description: "pnpm workspace with Next.js, Hono, and PostgreSQL/Prisma. Writes a manifest only.",
    },
    build: (projectName) => {
      const manifest = blueprints.reference!.build(projectName);
      const { mobile: _mobile, ...applications } = manifest.applications;
      const { EXPO_PUBLIC_API_URL: _expo, ...variables } = manifest.variables ?? {};
      void _mobile; void _expo;
      return { ...manifest, metadata: { ...manifest.metadata, description: "Web and API application" }, applications, variables };
    },
  },
};

export function listBlueprints(): BlueprintSummary[] {
  return Object.values(blueprints).map(({ summary }) => ({ ...summary }));
}

export function createBlueprintManifest(blueprintId: string, projectName: string): VibecoreManifest {
  const blueprint = blueprints[blueprintId];
  if (!blueprint) throw new Error(`Unknown blueprint ${JSON.stringify(blueprintId)}; expected ${listBlueprints().map(({ id }) => id).join(", ")}`);
  const name = projectName.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!name || name.length > 63) throw new Error("Project name is not a safe manifest identifier");
  return blueprint.build(name);
}
