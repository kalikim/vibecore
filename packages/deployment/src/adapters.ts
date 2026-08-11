import { join } from "node:path";
import type { ApplicationManifest, DeploymentConfigurationPlan, DeploymentWorkload, VibecoreManifest } from "@vibecore/contracts";
import { digestValue } from "@vibecore/planner";
import { evaluateDeploymentCompatibility, getDeploymentProvider, inferDeploymentWorkload } from "./index.js";

export interface DeploymentSetupOptions {
  provider: string;
  mode: string;
  application: string;
  environment: string;
  sourceRevision: string;
}

export function createDeploymentConfigurationPlan(manifest: VibecoreManifest, options: DeploymentSetupOptions): DeploymentConfigurationPlan {
  validateRevision(options.sourceRevision);
  const application = manifest.applications[options.application];
  if (!application) throw new Error(`Application is not declared: ${options.application}`);
  if (!manifest.environments[options.environment]) throw new Error(`Environment is not declared: ${options.environment}`);
  const provider = getDeploymentProvider(options.provider);
  if (!provider) throw new Error(`Unsupported deployment provider: ${options.provider}`);
  const compatibility = evaluateDeploymentCompatibility(manifest, options.application, provider.id, options.mode);
  if (!compatibility.compatible || !compatibility.workload) throw new Error(compatibility.reasons.join("; "));
  const requiredSecretNames = requiredSecrets(manifest, options.application, providerSecretNames(provider.id));
  const generated = generate(provider.id, options.mode, manifest, application, compatibility.workload, options, requiredSecretNames);
  const semantic = {
    provider: provider.id,
    application: options.application,
    environment: options.environment,
    sourceRevision: options.sourceRevision,
    files: generated.files,
    requiredSecretNames,
  };
  return { ...semantic, digest: digestValue(semantic), notes: generated.notes };
}

function generate(provider: string, mode: string, manifest: VibecoreManifest, application: ApplicationManifest, workload: DeploymentWorkload, options: DeploymentSetupOptions, secrets: string[]): Pick<DeploymentConfigurationPlan, "files" | "notes"> {
  const directory = `.vibecore/deployments/${provider}-${mode}`;
  const descriptor = {
    apiVersion: "vibecore.dev/deployment/v1alpha1",
    provider, mode, application: options.application, applicationPath: application.path,
    workload, environment: options.environment, sourceRevision: options.sourceRevision,
    buildCommand: application.commands?.build,
    startCommand: application.commands?.start,
    outputDirectory: stringConfig(application.config?.outputDirectory),
    port: numberConfig(application.config?.port, 3000),
    health: { path: application.health?.path ?? "/", timeoutSeconds: application.health?.timeoutSeconds ?? 60 },
    requiredSecretNames: secrets,
    rollback: rollbackStrategy(provider, mode),
  };
  const files = [{ path: `${directory}/deployment.json`, content: json(descriptor) }];
  const native = nativeConfiguration(provider, mode, manifest, application, options, directory);
  files.push(...native.files);
  return {
    files,
    notes: [
      `Generated ${provider}/${mode} configuration for ${options.environment}; no remote resource was created.`,
      `Deploy only source revision ${options.sourceRevision} after CI, policy, migration, and secret-name checks pass.`,
      ...native.notes,
      `Health verification must pass ${application.health?.path ?? "/"} before the release is marked healthy.`,
      `Rollback strategy: ${rollbackStrategy(provider, mode)}.`,
    ],
  };
}

function nativeConfiguration(provider: string, mode: string, manifest: VibecoreManifest, application: ApplicationManifest, options: DeploymentSetupOptions, directory: string): { files: Array<{ path: string; content: string }>; notes: string[] } {
  const name = safeName(`${manifest.metadata.name}-${options.application}-${options.environment}`);
  const root = application.path === "." ? "." : application.path;
  const port = numberConfig(application.config?.port, 3000);
  const health = application.health?.path ?? "/";
  const output = stringConfig(application.config?.outputDirectory) ?? "dist";
  if (provider === "railway") return { files: [{ path: join(application.path, "railway.json"), content: json({ "$schema": "https://railway.com/railway.schema.json", build: { builder: mode === "dockerfile" ? "DOCKERFILE" : "RAILPACK", ...(mode === "dockerfile" ? { dockerfilePath: "Dockerfile" } : {}) }, deploy: { ...(application.commands?.start ? { startCommand: application.commands.start } : {}), healthcheckPath: health, healthcheckTimeout: application.health?.timeoutSeconds ?? 60, restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 3 } }) }], notes: ["Connect the repository and set its Railway root directory to the application path.", "Create separate Railway environments for staging and production; inject secret values in the Railway dashboard or approved secret synchronization."] };
  if (provider === "digitalocean" && mode === "app-platform") return { files: [{ path: ".do/app.yaml", content: appSpec(name, root, application, port, health, output) }], notes: ["Validate the app spec with doctl before exact-approved creation.", "Configure encrypted environment values in App Platform; do not add them to the app spec."] };
  if (provider === "digitalocean" && mode === "droplet") return { files: [{ path: `${directory}/cloud-init.yaml`, content: cloudInit(name) }], notes: ["Create the Droplet with an SSH key, then replace the bootstrap user through your account-specific provisioning flow.", "Pin the server host key before deployment and keep the firewall restricted to SSH plus the application ingress ports."] };
  if (provider === "shared-hosting") return { files: [{ path: `${directory}/sftp-release.json`, content: json({ transport: "sftp", sourceDirectory: mode === "static-sftp" ? join(root, output) : root, destinationVariable: "DEPLOY_PATH", hostVariable: "DEPLOY_HOST", userVariable: "DEPLOY_USER", privateKeyVariable: "DEPLOY_SSH_PRIVATE_KEY", hostKeyVariable: "DEPLOY_HOST_KEY", releaseDirectory: `releases/${options.sourceRevision}`, atomicSymlink: true, deleteExtraneous: false }) }], notes: ["The host must support SSH/SFTP and, for atomic releases, symbolic links.", "If symbolic links are unavailable, Vibecore must use a host-specific versioned-directory adapter; it will not overwrite the live tree blindly."] };
  if (provider === "aws") return { files: [{ path: `${directory}/template.yaml`, content: awsTemplate(mode, name, port, health, output) }, { path: `${directory}/parameters.example.json`, content: json(awsParameters(mode, options.sourceRevision)) }], notes: ["Deploy the CloudFormation template with a GitHub OIDC role scoped to this stack and region.", "The example parameters contain identifiers only. Copy them to an ignored file and supply account-specific values."] };
  if (provider === "azure") return { files: [{ path: `${directory}/main.bicep`, content: azureBicep(mode, name, port) }, { path: `${directory}/parameters.example.json`, content: json({ environment: options.environment, sourceRevision: options.sourceRevision, location: "eastus" }) }], notes: ["Deploy Bicep using Azure workload identity federation from the protected GitHub environment.", "Supply repository, image, and resource-group identifiers through environment-scoped configuration."] };
  throw new Error(`Configuration generation is not implemented for ${provider}/${mode}`);
}

function appSpec(name: string, root: string, application: ApplicationManifest, port: number, health: string, output: string): string {
  if (inferDeploymentWorkload(application) === "static") return `name: ${name}\nstatic_sites:\n  - name: web\n    github:\n      repo: SET_IN_DIGITALOCEAN\n      branch: main\n      deploy_on_push: false\n    source_dir: ${root}\n    build_command: ${yamlScalar(application.commands?.build ?? "npm run build")}\n    output_dir: ${output}\n`;
  if (!application.commands?.start) throw new Error("DigitalOcean App Platform services must declare applications.<name>.commands.start");
  return `name: ${name}\nservices:\n  - name: app\n    github:\n      repo: SET_IN_DIGITALOCEAN\n      branch: main\n      deploy_on_push: false\n    source_dir: ${root}\n    ${application.commands?.build ? `build_command: ${yamlScalar(application.commands.build)}\n    ` : ""}run_command: ${yamlScalar(application.commands.start)}\n    http_port: ${port}\n    health_check:\n      http_path: ${health}\n`;
}

function cloudInit(name: string): string { return `#cloud-config\npackage_update: true\npackage_upgrade: true\npackages:\n  - docker.io\nusers:\n  - name: vibecore\n    groups: [docker]\n    shell: /bin/bash\n    lock_passwd: true\nssh_pwauth: false\ndisable_root: true\nwrite_files:\n  - path: /etc/vibecore-release\n    permissions: '0644'\n    content: '${name}'\nruncmd:\n  - [systemctl, enable, --now, docker]\n`;
}

function awsTemplate(mode: string, name: string, port: number, health: string, output: string): string {
  if (mode === "s3-cloudfront") return `AWSTemplateFormatVersion: '2010-09-09'\nDescription: Vibecore private S3 origin and CloudFront distribution\nResources:\n  SiteBucket:\n    Type: AWS::S3::Bucket\n    Properties:\n      BucketEncryption:\n        ServerSideEncryptionConfiguration:\n          - ServerSideEncryptionByDefault: { SSEAlgorithm: AES256 }\n      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true }\n      VersioningConfiguration: { Status: Enabled }\n  OriginAccessControl:\n    Type: AWS::CloudFront::OriginAccessControl\n    Properties:\n      OriginAccessControlConfig: { Name: ${name}, OriginAccessControlOriginType: s3, SigningBehavior: always, SigningProtocol: sigv4 }\n  Distribution:\n    Type: AWS::CloudFront::Distribution\n    Properties:\n      DistributionConfig:\n        Enabled: true\n        DefaultRootObject: index.html\n        Origins:\n          - Id: site\n            DomainName: !GetAtt SiteBucket.RegionalDomainName\n            S3OriginConfig: {}\n            OriginAccessControlId: !GetAtt OriginAccessControl.Id\n        DefaultCacheBehavior: { TargetOriginId: site, ViewerProtocolPolicy: redirect-to-https, Compress: true, AllowedMethods: [GET, HEAD, OPTIONS], CachedMethods: [GET, HEAD, OPTIONS], ForwardedValues: { QueryString: false, Cookies: { Forward: none } } }\n  BucketPolicy:\n    Type: AWS::S3::BucketPolicy\n    Properties:\n      Bucket: !Ref SiteBucket\n      PolicyDocument:\n        Statement:\n          - Effect: Allow\n            Principal: { Service: cloudfront.amazonaws.com }\n            Action: s3:GetObject\n            Resource: !Sub '\${SiteBucket.Arn}/*'\n            Condition: { StringEquals: { 'AWS:SourceArn': !Sub 'arn:\${AWS::Partition}:cloudfront::\${AWS::AccountId}:distribution/\${Distribution}' } }\nOutputs:\n  BucketName: { Value: !Ref SiteBucket }\n  DistributionId: { Value: !Ref Distribution }\n  OutputDirectory: { Value: '${output}' }\n`;
  if (mode === "app-runner") return `AWSTemplateFormatVersion: '2010-09-09'\nParameters:\n  ImageIdentifier: { Type: String }\nResources:\n  Service:\n    Type: AWS::AppRunner::Service\n    Properties:\n      ServiceName: ${name}\n      SourceConfiguration:\n        AutoDeploymentsEnabled: false\n        ImageRepository:\n          ImageIdentifier: !Ref ImageIdentifier\n          ImageRepositoryType: ECR_PUBLIC\n          ImageConfiguration: { Port: '${port}' }\n      HealthCheckConfiguration: { Protocol: HTTP, Path: '${health}', HealthyThreshold: 1, UnhealthyThreshold: 3 }\nOutputs:\n  ServiceUrl: { Value: !GetAtt Service.ServiceUrl }\n`;
  return `AWSTemplateFormatVersion: '2010-09-09'\nParameters:\n  ImageUri: { Type: String }\n  ClusterArn: { Type: String }\n  SubnetIds: { Type: List<AWS::EC2::Subnet::Id> }\n  SecurityGroupIds: { Type: List<AWS::EC2::SecurityGroup::Id> }\nResources:\n  LogGroup: { Type: AWS::Logs::LogGroup, Properties: { RetentionInDays: 30 } }\n  ExecutionRole:\n    Type: AWS::IAM::Role\n    Properties:\n      AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [{ Effect: Allow, Principal: { Service: ecs-tasks.amazonaws.com }, Action: 'sts:AssumeRole' }] }\n      ManagedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy']\n  TaskDefinition:\n    Type: AWS::ECS::TaskDefinition\n    Properties:\n      Cpu: '256'\n      Memory: '512'\n      NetworkMode: awsvpc\n      RequiresCompatibilities: [FARGATE]\n      ExecutionRoleArn: !GetAtt ExecutionRole.Arn\n      ContainerDefinitions:\n        - Name: app\n          Image: !Ref ImageUri\n          PortMappings: [{ ContainerPort: ${port} }]\n          LogConfiguration: { LogDriver: awslogs, Options: { awslogs-group: !Ref LogGroup, awslogs-region: !Ref 'AWS::Region', awslogs-stream-prefix: app } }\n  Service:\n    Type: AWS::ECS::Service\n    Properties:\n      Cluster: !Ref ClusterArn\n      DesiredCount: 1\n      LaunchType: FARGATE\n      TaskDefinition: !Ref TaskDefinition\n      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: DISABLED, Subnets: !Ref SubnetIds, SecurityGroups: !Ref SecurityGroupIds } }\n`;
}

function awsParameters(mode: string, revision: string): Record<string, string> { if (mode === "app-runner") return { ImageIdentifier: `public.ecr.aws/ACCOUNT/IMAGE:${revision}` }; if (mode === "ecs-fargate") return { ImageUri: `ACCOUNT.dkr.ecr.REGION.amazonaws.com/IMAGE:${revision}`, ClusterArn: "SET_IN_ENVIRONMENT", SubnetIds: "SET_IN_ENVIRONMENT", SecurityGroupIds: "SET_IN_ENVIRONMENT" }; return { ArtifactRevision: revision }; }

function azureBicep(mode: string, name: string, port: number): string {
  const prefix = `param location string = resourceGroup().location\nparam sourceRevision string\n`;
  if (mode === "static-web-apps") return `${prefix}resource site 'Microsoft.Web/staticSites@2023-12-01' = {\n  name: '${name}'\n  location: location\n  sku: { name: 'Free', tier: 'Free' }\n  properties: { repositoryUrl: '' branch: 'main' allowConfigFileUpdates: false }\n}\noutput defaultHostname string = site.properties.defaultHostname\n`;
  if (mode === "container-apps") return `${prefix}param image string\nresource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = { name: '${name}-logs' location: location properties: { retentionInDays: 30 } }\nresource environment 'Microsoft.App/managedEnvironments@2024-03-01' = { name: '${name}-env' location: location properties: { appLogsConfiguration: { destination: 'log-analytics' logAnalyticsConfiguration: { customerId: workspace.properties.customerId sharedKey: workspace.listKeys().primarySharedKey } } } }\nresource app 'Microsoft.App/containerApps@2024-03-01' = { name: '${name}' location: location properties: { managedEnvironmentId: environment.id configuration: { ingress: { external: true targetPort: ${port} transport: 'auto' } } template: { containers: [{ name: 'app' image: image resources: { cpu: json('0.25') memory: '0.5Gi' } }] scale: { minReplicas: 0 maxReplicas: 3 } } } }\noutput hostname string = app.properties.configuration.ingress.fqdn\n`;
  return `${prefix}param runtimeStack string = 'NODE|22-lts'\nresource plan 'Microsoft.Web/serverfarms@2023-12-01' = { name: '${name}-plan' location: location sku: { name: 'B1' tier: 'Basic' } properties: { reserved: true } }\nresource app 'Microsoft.Web/sites@2023-12-01' = { name: '${name}' location: location properties: { serverFarmId: plan.id httpsOnly: true siteConfig: { linuxFxVersion: runtimeStack ftpsState: 'Disabled' minTlsVersion: '1.2' alwaysOn: true healthCheckPath: '/' } } }\noutput hostname string = app.properties.defaultHostName\n`;
}

function rollbackStrategy(provider: string, mode: string): string { if (provider === "shared-hosting") return "atomically repoint the current symlink to the preceding immutable release"; if (provider === "aws" && mode === "s3-cloudfront") return "restore the preceding versioned artifact and invalidate CloudFront"; if (provider === "digitalocean" && mode === "droplet") return "restart the preceding immutable container image digest"; return "redeploy the preceding healthy immutable source revision or image digest"; }
function requiredSecrets(manifest: VibecoreManifest, applicationName: string, providerSecrets: string[]): string[] { return [...new Set([...providerSecrets, ...Object.entries(manifest.variables ?? {}).filter(([, variable]) => variable.secret && (!variable.applications || variable.applications.includes(applicationName))).map(([name]) => name)])].sort(); }
function providerSecretNames(provider: string): string[] { if (provider === "railway") return ["RAILWAY_TOKEN"]; if (provider === "digitalocean") return ["DIGITALOCEAN_ACCESS_TOKEN"]; if (provider === "shared-hosting") return ["DEPLOY_SSH_PRIVATE_KEY"]; return []; }
function validateRevision(value: string): void { if (!/^[a-f0-9]{7,64}$/i.test(value)) throw new Error("Deployment source revision must be a Git commit SHA"); }
function safeName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 48); }
function numberConfig(value: unknown, fallback: number): number { if (value === undefined) return fallback; if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) throw new Error("Deployment port must be an integer from 1 to 65535"); return value as number; }
function stringConfig(value: unknown): string | undefined { if (value === undefined) return undefined; if (typeof value !== "string" || value.startsWith("/") || value.includes("..")) throw new Error("Deployment outputDirectory must be a safe relative path"); return value; }
function yamlScalar(value: string): string { return JSON.stringify(value); }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
