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
    <tr><td>AWS</td><td>GitHub OIDC role federation</td><td>No long-lived AWS access key</td></tr>
    <tr><td>Azure</td><td>GitHub workload identity federation</td><td>No client secret</td></tr>
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
Managed-provider remote execution of that plan remains explicit and pending.

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
