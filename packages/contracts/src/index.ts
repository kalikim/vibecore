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
  language?: string;
  path: string;
  confidence: DetectionConfidence;
  evidence: DetectionEvidence[];
  commands?: Partial<Record<"dev" | "build" | "test" | "start", string>>;
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
  language?: string;
  path: string;
  dependsOn?: string[];
  commands?: Partial<Record<"dev" | "build" | "test" | "start", string>>;
  health?: { path?: string; timeoutSeconds?: number };
  config?: Record<string, unknown>;
}

export interface LanguageAdapterMetadata {
  id: string;
  displayName: string;
  packageTools: string[];
  frameworks: string[];
  detectionFiles: string[];
  status: "implemented" | "planned";
}

export interface ApiDocumentationAdapter {
  framework: string;
  strategy: string;
  packages: string[];
  specificationPath: string;
  uiPath: string;
}

export interface OpenApiScaffold {
  application: string;
  path: string;
  digest: string;
  document: Record<string, unknown>;
  source: string;
  diagnostics: Diagnostic[];
}

export interface DiscoveredApiRoute {
  method: "get" | "post" | "put" | "patch" | "delete" | "options" | "head";
  path: string;
  framework: string;
  confidence: DetectionConfidence;
  evidence: DetectionEvidence[];
  requiresReview?: boolean;
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

export type PolicyEffect = "allow" | "deny" | "require-approval";

export interface PolicyDecision {
  code: string;
  effect: PolicyEffect;
  message: string;
  actionId?: string;
}

export type PlanExecutionStatus = "approved" | "executing" | "succeeded" | "failed" | "interrupted";
export type ActionExecutionStatus = "pending" | "executing" | "succeeded" | "failed" | "skipped";

export interface PlanLedgerEntry {
  id: string;
  digest: string;
  environment: string;
  createdAt: string;
  updatedAt: string;
  status: PlanExecutionStatus;
  actions: Array<{
    id: string;
    status: ActionExecutionStatus;
    errorCode?: string;
  }>;
}

export interface VibecoreState {
  apiVersion: "vibecore.dev/state/v1alpha1";
  plans: PlanLedgerEntry[];
  releases: Release[];
}

export type DevProcessStatus = "starting" | "healthy" | "running" | "stopping" | "stopped" | "failed";

export interface DevProcessRecord {
  application: string;
  pid: number;
  port: number;
  status: DevProcessStatus;
}

export interface DevResourceRecord {
  name: string;
  provider: string;
  projectName: string;
  status: "starting" | "ready" | "stopping" | "stopped" | "failed";
}

export interface DevSessionRecord {
  apiVersion: "vibecore.dev/session/v1alpha1";
  id: string;
  repositoryRoot: string;
  createdAt: string;
  updatedAt: string;
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  resources: DevResourceRecord[];
  processes: DevProcessRecord[];
}

export interface Release {
  id: string;
  application: string;
  provider: string;
  mode: string;
  environment: string;
  sourceRevision: string;
  planDigest: string;
  status: "deploying" | "healthy" | "unhealthy" | "rolled-back" | "failed";
  createdAt: string;
  updatedAt: string;
  health?: DeploymentHealthResult;
  rollbackOf?: string;
}

export interface DeploymentHealthResult {
  url: string;
  status: "healthy" | "unhealthy";
  checkedAt: string;
  attempts: number;
  statusCode?: number;
  durationMs: number;
  errorCode?: string;
}

export interface DeploymentRollbackPlan {
  provider: string;
  mode: string;
  application: string;
  environment: string;
  failedReleaseId: string;
  targetReleaseId: string;
  targetSourceRevision: string;
  strategy: string;
  digest: string;
}

export interface DeploymentConfigurationPlan {
  provider: string;
  application: string;
  environment: string;
  sourceRevision: string;
  digest: string;
  files: Array<{ path: string; content: string }>;
  requiredSecretNames: string[];
  notes: string[];
}

export type DeploymentProviderKind = "managed-platform" | "cloud" | "server" | "shared-hosting";
export type DeploymentWorkload = "static" | "node" | "python" | "go" | "php" | "rust" | "jvm" | "dotnet" | "container";
export type DeploymentCapabilityStatus = "implemented" | "planned" | "unsupported";
export type DeploymentCostProfile = "free-tier" | "low-cost" | "usage-based" | "infrastructure";

export interface DeploymentModeMetadata {
  id: string;
  displayName: string;
  workloads: DeploymentWorkload[];
  source: "git" | "container-image" | "artifact" | "ssh-sftp";
  configure: DeploymentCapabilityStatus;
  preview: DeploymentCapabilityStatus;
  deploy: DeploymentCapabilityStatus;
  rollback: DeploymentCapabilityStatus;
  notes: string[];
}

export interface DeploymentProviderMetadata {
  id: string;
  displayName: string;
  kind: DeploymentProviderKind;
  costProfiles: DeploymentCostProfile[];
  credentialNames: string[];
  modes: DeploymentModeMetadata[];
  notes: string[];
}

export interface DeploymentCompatibility {
  provider: string;
  mode: string;
  application: string;
  workload?: DeploymentWorkload;
  compatible: boolean;
  status: DeploymentCapabilityStatus;
  reasons: string[];
}

export type DatabaseMigrationRisk = "safe" | "review" | "destructive";

export interface DatabaseMigrationFinding {
  risk: DatabaseMigrationRisk;
  code: string;
  message: string;
  statement: string;
}

export interface DatabaseMigrationInspection {
  name: string;
  path: string;
  checksum: string;
  risk: DatabaseMigrationRisk;
  findings: DatabaseMigrationFinding[];
}

export interface PrismaDatabaseInspection {
  schemaPath: string;
  datasource: string;
  provider: string;
  urlEnvironmentVariable?: string;
  migrationsPath: string;
  migrations: DatabaseMigrationInspection[];
  risk: DatabaseMigrationRisk;
  diagnostics: Diagnostic[];
}

export interface PrismaLiveCheck {
  command: "validate" | "status" | "drift";
  status: "in-sync" | "changes-detected" | "failed";
  exitCode: number;
  output: string;
}

export type DatabaseAdapterKind = "engine" | "tool" | "provider";
export type DatabaseCapability =
  | "detect"
  | "inspect"
  | "validate"
  | "local-runtime"
  | "provision"
  | "deploy-migrations"
  | "backup"
  | "branching";
export type CapabilitySupport = "implemented" | "planned" | "unsupported";

export interface DatabaseAdapterCapability {
  capability: DatabaseCapability;
  support: CapabilitySupport;
  note: string;
}

export interface DatabaseAdapterMetadata {
  id: string;
  displayName: string;
  kind: DatabaseAdapterKind;
  engines: string[];
  capabilities: DatabaseAdapterCapability[];
  environmentVariables?: string[];
  documentationUrl?: string;
}

export interface DetectedDatabaseIntegration {
  adapterId: string;
  kind: DatabaseAdapterKind;
  confidence: DetectionConfidence;
  evidence: DetectionEvidence[];
}

export interface DatabaseStackDiagnosticResult {
  engine: string;
  tool?: string;
  provider?: string;
  diagnostics: Diagnostic[];
}

export interface DatabaseToolInspection {
  tool: "drizzle" | "mongodb";
  path: string;
  migrations: DatabaseMigrationInspection[];
  risk: DatabaseMigrationRisk;
  diagnostics: Diagnostic[];
}
