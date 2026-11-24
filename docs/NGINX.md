# Nginx configuration candidates

`vibe deploy nginx --domain app.example.com --port 3000 --json` previews a
single-host HTTPS reverse-proxy candidate. Without `--json`, it prints configuration
with review notes as comments. It does not write files, inspect a host, read keys,
issue certificates, reload Nginx, or deploy. There is deliberately no `--apply`.

Requires an existing certificate. Generated Let's Encrypt paths are assumptions,
not verified paths; Certbot lineage names may differ. Never replace an existing
Certbot-managed site wholesale with this candidate. Review the full configuration
and renewal method first. HTTP redirects to a fixed hostname, not the request Host.
TLS is restricted to 1.2/1.3. The upstream is loopback-only, with bounded timeouts
and a 1 MiB request-body limit. The application must actually bind to loopback;
Docker ports and firewall policy are not changed by this command.

The direct-edge proxy replaces forwarded headers rather than trusting client
values. Configure application proxy trust narrowly. CDN/load-balancer chains,
WebSockets, static/PHP hosting, IPv6 listeners, default-host rejection, CSP, HSTS,
and rate limiting need separate review. Dot paths, including `.well-known`, and
dependency-tree paths are blocked. This can affect applications and ACME renewal;
review explicit exceptions rather than assuming renewal works. These rules cannot
repair insecure application routes or remove secrets from browser bundles.

## Activation remains manual

Inspect existing sites and certificate coverage, preserve backups, review the
exact diff, and approve the target. Validate the complete staged configuration
with `nginx -t`, not this fragment alone. After approved installation validate
again before graceful reload. Verify HTTPS, redirects, health, and blocked paths;
restore and validate the backup if checks fail. Automatic activation, locking,
rollback, certificate bootstrap/renewal, and live acceptance tests remain pending.

## Reproducible Nginx integration check

Run `pnpm test:nginx` on Linux with Docker and OpenSSL available. The script builds
the CLI, creates a one-day disposable test certificate, and runs the exact generated
candidate inside a digest-pinned Nginx container. Only random loopback host ports
are published. The container runs as the invoking user, drops all capabilities,
uses a read-only filesystem and fixture mounts, and has bounded temporary storage.
The image is an integration fixture, not a production-version recommendation.
Docker may download the pinned image if absent.

Checks include trusted HTTPS with hostname verification, HTTP redirects, forwarding
header replacement, dot/dependency-path blocking, request-body limits, invalid
configuration rejection, and continued service after a failed reload. The test
restores the valid configuration and reloads it. It removes only its own uniquely
named container and generated files on normal completion or caught failure.
Forced termination can leave fixtures behind; no global Docker cleanup is performed.

This is a real local Nginx test with a synthetic upstream, not proof of production
deployment, Certbot renewal, server activation rollback, or every Nginx version.
The Node 24 CI job includes this gate; its remote result must be checked after push.

See official [HTTPS configuration](https://nginx.org/en/docs/http/configuring_https_servers.html),
[proxy directives](https://nginx.org/en/docs/http/ngx_http_proxy_module.html), and
[reload behavior](https://nginx.org/en/docs/control.html).

## Source-only CLI access

The CLI is prepared as version 0.1.0-alpha.1; npm publication is not yet verified. With Node.js 22+ and
pnpm 10.30.3, clone the public repository outside your application, run
`pnpm install --frozen-lockfile` and `pnpm build`, then invoke
`node /absolute/path/to/vibecore/apps/cli/dist/index.js --help` from your application.
Only pushed code is available to others. A global `vibe` command is not installed
by cloning. Automated server activation and npm publication are separate milestones.
