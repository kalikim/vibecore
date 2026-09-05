# Deployment adapters

Vibecore separates configuration, remote deployment, health verification, and
rollback. `vibe deploy setup` currently implements deterministic configuration. It
does not create infrastructure, spend cloud credits, change DNS, or upload secrets.

Every plan is bound to an immutable Git commit SHA. Writing generated files requires
the exact plan digest, and existing files are never overwritten.

## Provider matrix

<table>
  <thead style="background-color: #111827; color: #f9fafb;">
    <tr><th>Provider</th><th>Mode</th><th>Generated configuration</th><th>Account prerequisites</th></tr>
  </thead>
  <tbody>
    <tr><td>Railway</td><td><code>git</code></td><td><code>railway.json</code> using Railpack</td><td>Railway project and linked Git repository</td></tr>
    <tr><td>Railway</td><td><code>dockerfile</code></td><td><code>railway.json</code> using a Dockerfile</td><td>Railway project, linked repository, and application Dockerfile</td></tr>
    <tr><td>AWS</td><td><code>s3-cloudfront</code></td><td>CloudFormation with private versioned S3 origin and CloudFront OAC</td><td>AWS account, region, and GitHub OIDC deployment role</td></tr>
    <tr><td>AWS</td><td><code>app-runner</code></td><td>CloudFormation App Runner service</td><td>Immutable public ECR image reference and GitHub OIDC role</td></tr>
    <tr><td>AWS</td><td><code>ecs-fargate</code></td><td>CloudFormation task, service, logs, and execution role</td><td>ECS cluster, private subnets, security groups, ECR image, and OIDC role</td></tr>
    <tr><td>Azure</td><td><code>static-web-apps</code></td><td>Bicep Static Web App</td><td>Subscription, resource group, and workload identity</td></tr>
    <tr><td>Azure</td><td><code>app-service</code></td><td>Bicep Linux App Service and plan</td><td>Subscription, resource group, runtime choice, and workload identity</td></tr>
    <tr><td>Azure</td><td><code>container-apps</code></td><td>Bicep Container App, environment, and logs</td><td>Subscription, resource group, immutable image, and workload identity</td></tr>
    <tr><td>DigitalOcean</td><td><code>app-platform</code></td><td><code>.do/app.yaml</code></td><td>DigitalOcean project and Git repository or image access</td></tr>
    <tr><td>DigitalOcean</td><td><code>droplet</code></td><td>Hardened cloud-init baseline</td><td>Droplet, SSH key, pinned host key, firewall, and non-root user</td></tr>
    <tr><td>Shared hosting</td><td><code>static-sftp</code></td><td>Versioned SFTP release descriptor</td><td>SSH/SFTP, deployment directory, host key, and static build output</td></tr>
    <tr><td>Shared hosting</td><td><code>php-sftp</code></td><td>Versioned SFTP release descriptor</td><td>SSH/SFTP, compatible PHP runtime, deployment directory, and host key</td></tr>
    <tr><td>Self-hosted</td><td><code>docker-compose</code></td><td>Versioned Compose release executed over SSH</td><td>Rootless Docker preferred, non-root SSH user, pinned host key, immutable image digest, and pre-provisioned environment file</td></tr>
  </tbody>
</table>

## Planning configuration

```sh
pnpm vibe deploy setup \
  --provider railway \
  --mode git \
  --application api \
  --environment staging \
  --revision <git-sha>
```

Review the files, notes, required secret names, source revision, and digest. Apply
the local configuration only after review:

```sh
pnpm vibe deploy setup \
  --provider railway \
  --mode git \
  --application api \
  --environment staging \
  --revision <git-sha> \
  --write \
  --approve <digest>
```

Use `vibe deploy support --application <name>` to reject modes that cannot run the
application workload. Container modes require:

```yaml
applications:
  api:
    config:
      deploymentWorkload: container
```

This is an explicit boundary. Vibecore does not assume that every application has a
secure, production-ready Dockerfile.

## Environment and identity contract

`dev`, `staging`, and `production` remain separate deployment environments. Provider
account identifiers and regions are environment configuration, not secrets. Runtime
credentials and application secrets are injected at deployment time and never placed
in generated plans.

<table>
  <thead style="background-color: #111827; color: #f9fafb;">
    <tr><th>Provider</th><th>Identity approach</th><th>Secret names when required</th></tr>
  </thead>
  <tbody>
    <tr><td>Railway</td><td>Scoped project token for automation</td><td><code>RAILWAY_TOKEN</code></td></tr>
    <tr><td>AWS</td><td>Current AWS CLI identity locally; GitHub OIDC role federation in CI</td><td>No long-lived AWS access key</td></tr>
    <tr><td>Azure</td><td>Current <code>az</code> login locally; GitHub workload identity federation in CI</td><td>No client secret</td></tr>
    <tr><td>DigitalOcean</td><td>Scoped API token or repository connection</td><td><code>DIGITALOCEAN_ACCESS_TOKEN</code></td></tr>
    <tr><td>Droplet</td><td>Pinned SSH host key and non-root deployment key</td><td>Deployment key supplied by the operator</td></tr>
    <tr><td>Shared hosting</td><td>Pinned SSH host key and application-scoped SFTP key</td><td><code>DEPLOY_SSH_PRIVATE_KEY</code></td></tr>
  </tbody>
</table>

Plain FTP, root SSH deployment, passwords in command arguments, mutable image tags,
and secret values committed to provider configuration are unsupported.

## Release safety contract

Before a future remote executor marks a release healthy, it must verify the declared
health path within the configured timeout. Rollback always targets the preceding
healthy immutable revision or image digest. Static AWS releases restore a versioned
artifact and invalidate CloudFront. Shared hosting uses an atomic release symlink
when supported and refuses a blind live-tree overwrite when it is not.

The shared release lifecycle is implemented locally. `vibe deploy releases` reads
the secret-free ledger, `vibe deploy verify-health` performs bounded HTTP checks
without following redirects or storing response bodies, and `vibe deploy rollback`
selects the preceding healthy immutable release and creates a tamper-evident plan.
Self-hosted Docker, Railway, DigitalOcean App Platform and Droplet, Azure App
Service and Container Apps, AWS S3/CloudFront, App Runner, and ECS Fargate, and
shared-hosting SSH/SFTP can apply that plan through their executors.

## Self-hosted Docker execution

Self-hosted Docker forward deployment and rollback execution are implemented. The
server must already have Docker Compose, the deployment user, its authorized SSH
key, and an environment file at:

```text
<remote-root>/environments/<environment>.env
```

Vibecore checks that file exists but never uploads, reads, prints, or stores it. It
uploads only a versioned Compose file, pulls an image pinned with a SHA-256 digest,
starts it with Compose's wait gate, verifies the externally reachable health URL,
and updates the `current` symlink only after health succeeds.

The generated service uses a read-only filesystem, drops all Linux capabilities,
sets `no-new-privileges`, uses a bounded temporary filesystem, and publishes the
container port to loopback only. Put a separately managed TLS reverse proxy in front
of it. Root SSH, password authentication, unknown host keys, mutable image tags, and
automatic secret provisioning are refused.

```sh
vibe deploy self-hosted --application api --environment staging \
  --revision <git-sha> --host app.example.com --user vibecore \
  --health-url https://app.example.com/health

vibe deploy self-hosted-rollback --release <failed-release-id> \
  --host app.example.com --user vibecore \
  --remote-root /opt/vibecore/my-project \
  --health-url https://app.example.com/health \
  --ssh-key /absolute/key/path --approve <rollback-digest>
```

## Shared-hosting execution

Shared-hosting static and PHP forward deployment and rollback are implemented over
SSH/SFTP. The host must already have a pinned host key, a non-root deployment user,
and an application-scoped directory that can hold versioned releases plus a
`current` symlink.

Vibecore copies the static output directory (`static-sftp`) or the application path
(`php-sftp`) into `<remote-root>/releases/<sha>/`, refuses to replace `current` when
it is a real directory, then atomically repoints the symlink. Health is verified on
the public URL after the switch. Plain FTP, password authentication, root SSH, and
in-place live-tree overwrites are refused.

```sh
vibe deploy shared-hosting --application web --environment staging \
  --revision <git-sha> --mode static-sftp \
  --host host.example.com --user deploy \
  --remote-root /home/deploy/site \
  --health-url https://site.example.com/health

vibe deploy shared-hosting-rollback --release <failed-release-id> \
  --host host.example.com --user deploy \
  --remote-root /home/deploy/site \
  --health-url https://site.example.com/health \
  --ssh-key /absolute/key/path --approve <rollback-digest>
```

## Railway execution

Railway forward deployment is implemented for existing projects using both Railpack
and Dockerfile modes. Vibecore runs Railway non-interactively with explicit project,
service, and environment targets. It never uses the CLI's first-run project creation
flow.

```sh
vibe deploy railway --application api --environment staging \
  --revision <current-git-sha> --project <project-id> --service <service-id> \
  --health-url https://api.example.com/health
```

Set the project-scoped token in the process environment only:

```sh
export RAILWAY_TOKEN=<project-scoped-token>
```

Then repeat the reviewed command with `--apply --approve <digest>`. Before upload,
Vibecore verifies that repository `HEAD` matches the planned revision and that the
application path has no uncommitted changes. Railway's CI mode must complete
successfully, followed by Vibecore's external health check, before the release is
recorded healthy.

The Railway CLI currently supports redeploying the latest source, but does not expose
selection of an arbitrary historical deployment for rollback. Vibecore therefore
marks Railway rollback as unsupported instead of treating `railway redeploy` as a
rollback. The local rollback plan still identifies the preceding healthy revision for
an operator using Railway's deployment dashboard.

## DigitalOcean App Platform execution

Forward deployment and historical rollback are implemented for existing
GitHub-backed App Platform apps. Vibecore does not implicitly create a paid app and
does not replace its complete app spec during each release.

```sh
vibe deploy digitalocean --application api --environment staging \
  --revision <full-current-git-sha> --app-id <app-id> \
  --repository owner/repository --branch main \
  --health-url https://api.example.com/health
```

Deploy-on-push must be disabled. Before execution, Vibecore verifies local `HEAD`,
checks the application and `.do/app.yaml` for uncommitted changes, confirms the
configured App Platform repository and branch, and verifies that the Git remote
branch still points to the approved SHA. The access token is written only to a
temporary mode-`0600` doctl config file and deleted after the command completes.

DigitalOcean's deployment ID is stored alongside the secret-free release metadata.
For an unhealthy release, first generate the generic rollback digest and then apply
it:

```sh
vibe deploy rollback --release <failed-release-id>

vibe deploy digitalocean-rollback --release <failed-release-id> \
  --health-url https://api.example.com/health \
  --approve <rollback-digest>
```

The executor calls DigitalOcean's rollback validation endpoint before creating the
historical rollback. Database data is not rolled back by App Platform and still
requires a separate database backup and recovery workflow.

## DigitalOcean Droplet execution

Existing Droplet forward deployment and rollback are implemented. Vibecore does not
create, resize, patch, or firewall Droplets. Cloud-init is a bootstrap artifact the
operator applies when creating the server.

The Droplet must already be `active` and must match the approved host name or public
address. Docker Compose, a non-root SSH user, a pinned host key, and an environment
file at `<remote-root>/environments/<environment>.env` are required. The application
must declare a digest-pinned `config.deploymentImage`.

```sh
vibe deploy digitalocean-droplet --application api --environment staging \
  --revision <git-sha> --droplet-id <droplet-id> \
  --host 203.0.113.10 --user vibecore \
  --health-url https://api.example.com/health

vibe deploy digitalocean-droplet-rollback --release <failed-release-id> \
  --host 203.0.113.10 --user vibecore \
  --remote-root /opt/vibecore/my-project \
  --health-url https://api.example.com/health \
  --ssh-key /absolute/key/path --approve <rollback-digest>
```

`doctl` confirms droplet identity using a temporary mode-`0600` config file. The
Compose release, pull, wait gate, health check, and `current` symlink follow the
self-hosted Docker contract. Root SSH, password authentication, unknown host keys,
and mutable image tags are refused.

## Azure execution

Forward deployment is implemented for existing Azure resources. Vibecore does not
create resource groups, App Service plans, Container Apps environments, or Static
Web Apps, and it will not run `az login` or accept a client secret.

```sh
vibe deploy azure --application api --environment staging \
  --revision <full-current-git-sha> --mode app-service \
  --subscription <subscription-guid> --tenant <tenant-guid> \
  --resource-group rg-app --name api-staging \
  --health-url https://api.example.com/health
```

Log in with `az login` or GitHub workload identity first. Before execution,
Vibecore verifies that the Azure CLI subscription and tenant match the plan, that
repository `HEAD` matches the approved SHA, and that the application path and
generated Azure configuration are clean.

- **App Service** zip-deploys `git archive` of the application path. The existing
  Linux app must already enable HTTPS-only, disable FTPS, and set
  `SCM_DO_BUILD_DURING_DEPLOYMENT=true`. Container workloads update
  `config.deploymentImage` pinned with `@sha256:<digest>`.
- **Container Apps** require `config.deploymentWorkload: container`, a digest-pinned
  image, and multiple revision mode. Vibecore updates the image, then shifts 100%
  of ingress traffic to the new revision before the external health check.
- **Static Web Apps** deploy a built output directory through `swa deploy` using the
  current Azure CLI identity. Disconnect GitHub first so repository auto-deploy
  cannot race the approved revision. Historical rollback is unsupported because
  Azure does not retain previous static artifacts.

```sh
vibe deploy rollback --release <failed-release-id>

vibe deploy azure-rollback --release <failed-release-id> \
  --tenant <tenant-guid> \
  --health-url https://api.example.com/health \
  --approve <rollback-digest>
```

App Service rollback re-archives the preceding healthy SHA. Container Apps rollback
shifts traffic to the recorded revision. Database data is not rolled back.

## AWS execution

Forward deployment and rollback are implemented for existing AWS resources. Vibecore
does not create buckets, distributions, App Runner services, ECS clusters, or task
roles, and it will not run `aws configure` or accept access keys as flags.

```sh
vibe deploy aws --application web --environment staging \
  --revision <full-current-git-sha> --mode s3-cloudfront \
  --account <12-digit-account-id> --region us-east-1 \
  --bucket app-assets --distribution E123456789ABCD \
  --health-url https://app.example.com/health
```

Authenticate with `aws sso login` or an OIDC assumed role first. Before execution,
Vibecore verifies that `sts get-caller-identity` matches the approved account, that
repository `HEAD` matches the approved SHA, and that the application path and
generated AWS configuration are clean.

- **S3 and CloudFront** require a private, fully blocked, versioned bucket whose
  CloudFront origin already points at that bucket. Vibecore syncs the built output
  to `s3://bucket/releases/<sha>/`, sets the origin path to that prefix, and
  invalidates `/*`.
- **App Runner** requires `config.deploymentWorkload: container`, a digest-pinned
  `config.deploymentImage`, and automatic deployments disabled. Vibecore updates the
  existing service and waits until it is running.
- **ECS Fargate** copies the current task definition family, replaces the `app`
  container image with the digest-pinned image, registers a new revision, and waits
  for the service to stabilize. Assign public IP must already be disabled.

```sh
vibe deploy rollback --release <failed-release-id>

vibe deploy aws-rollback --release <failed-release-id> \
  --health-url https://app.example.com/health \
  --approve <rollback-digest>
```

S3/CloudFront rollback retargets the origin path to the preceding release prefix.
App Runner rollback updates the service to the preceding image digest. ECS rollback
points the service at the preceding task definition ARN. Database data is not rolled
back.
