export type DiagnosticSeverity = "info" | "warning" | "error";

export interface DiagnosticEvidence {
  source: string;
  detail: string;
}

export interface DiagnosticFix {
  adapter: string;
  operation: string;
}

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  component?: string;
  evidence?: DiagnosticEvidence[];
  fix?: DiagnosticFix;
}

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";
export type ApplicationType = "web" | "api" | "mobile" | "worker";
export type DetectionConfidence = "high" | "medium" | "low";

export interface DetectionEvidence {
  source: string;
  detail: string;
}

export interface DetectedApplication {
  name: string;
  type: ApplicationType;
  framework: string;
  path: string;
  confidence: DetectionConfidence;
  evidence: DetectionEvidence[];
}

export interface DetectedResource {
  name: string;
  type: string;
  provider: string;
  confidence: DetectionConfidence;
  evidence: DetectionEvidence[];
  config?: Record<string, unknown>;
}

export interface RepositoryScan {
  root: string;
  fingerprint: string;
  packageManager?: {
    name: PackageManager;
    confidence: DetectionConfidence;
    evidence: DetectionEvidence[];
  };
  applications: DetectedApplication[];
  resources: DetectedResource[];
  diagnostics: Diagnostic[];
}

export type ProjectNodeKind = "application" | "resource" | "environment";

export interface ProjectNode {
  id: string;
  name: string;
  kind: ProjectNodeKind;
  data: ApplicationManifest | ResourceManifest | VibecoreManifest["environments"][string];
}

export interface ProjectEdge {
  from: string;
  to: string;
  kind: "depends-on" | "targets";
}

export interface ProjectGraph {
  nodes: ProjectNode[];
  edges: ProjectEdge[];
  diagnostics: Diagnostic[];
}

export interface ApplicationManifest {
  type: ApplicationType;
  framework: string;
  path: string;
  dependsOn?: string[];
  commands?: Partial<Record<"dev" | "build" | "test" | "start", string>>;
  health?: { path?: string; timeoutSeconds?: number };
  config?: Record<string, unknown>;
}

export interface ResourceManifest {
  type: string;
  provider: string;
  config?: Record<string, unknown>;
}

export interface VibecoreManifest {
  $schema?: string;
  apiVersion: "vibecore.dev/v1alpha1";
  kind: "Application";
  metadata: { name: string; description?: string };
  workspace?: {
    packageManager?: PackageManager;
    root?: string;
  };
  applications: Record<string, ApplicationManifest>;
  resources?: Record<string, ResourceManifest>;
  variables?: Record<
    string,
    {
      required: boolean;
      secret?: boolean;
      description?: string;
      applications?: string[];
    }
  >;
  environments: Record<
    string,
    {
      runtime: string;
      production?: boolean;
      overrides?: Record<string, unknown>;
      variableSources?: Record<string, string>;
    }
  >;
  policies?: {
    requirePlan?: boolean;
    requireProductionApproval?: boolean;
    requireBackupForDestructiveMigration?: boolean;
  };
}

export type ActionRisk = "read" | "write" | "destructive";

export interface PermissionRequest {
  kind: "filesystem" | "network" | "process" | "secret";
  target: string;
  access: "read" | "write" | "execute";
}

export interface Action {
  id: string;
  adapter: string;
  operation: string;
  summary: string;
  risk: ActionRisk;
  dependsOn: string[];
  inputs: unknown;
  permissions: PermissionRequest[];
  rollback?: { operation: string; inputs: unknown };
}

export interface Plan {
  apiVersion: "vibecore.dev/plan/v1alpha1";
  id: string;
  digest: string;
  createdAt: string;
  repositoryFingerprint: string;
  environment: string;
  actions: Action[];
}

export interface Release {
  id: string;
  environment: string;
  sourceRevision: string;
  planDigest: string;
  status: "deploying" | "healthy" | "unhealthy" | "rolled-back" | "failed";
  createdAt: string;
}
