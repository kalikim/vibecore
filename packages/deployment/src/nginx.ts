import { digestValue } from "@codexsafari/vibecore-planner";

export interface NginxPlanOptions {
  domain: string;
  port: number;
}

/** A candidate only: never reads certificates, writes files, or contacts a server. */
export function createNginxPlan(options: NginxPlanOptions) {
  const domain = options.domain.toLowerCase();
  const labels = domain.split(".");
  if (domain.length > 253 || labels.length < 2 || labels.some((label) =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    !/[a-z]/.test(labels.at(-1)!)) {
    throw new Error("Use a DNS hostname without a scheme, wildcard, port, or path");
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error("Upstream port must be an integer between 1024 and 65535");
  }
  const config = `# Candidate only. Include inside http {}; review against existing server configuration.
# Requires an existing certificate covering ${domain}. Does not issue or renew it.
server {
    listen 80;
    server_name ${domain};
    return 308 https://${domain}$request_uri;
}

server {
    listen 443 ssl;
    server_name ${domain};
    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    server_tokens off;
    client_max_body_size 1m;
    client_body_timeout 15s;
    client_header_timeout 15s;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;

    # Never forward dotfile or dependency-tree requests to the application.
    location ~ (^|/)\\. { return 404; }
    location ~* (^|/)(node_modules|vendor)(/|$) { return 404; }

    location / {
        proxy_pass http://127.0.0.1:${options.port};
        proxy_http_version 1.1;
        proxy_set_header Host ${domain};
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host ${domain};
        proxy_set_header X-Forwarded-Port 443;
        proxy_set_header Forwarded "";
        proxy_set_header Connection "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
    }
}
`;
  const semantic = { kind: "nginx-candidate" as const, domain, port: options.port, config };
  return {
    ...semantic,
    digest: digestValue(semantic),
    status: "unvalidated" as const,
    limitations: [
      "No server inspection, writes, certificate issuance, reload, or deployment has occurred.",
      "Existing certificate paths and domain coverage must be checked; Certbot lineage names may differ.",
      "Single direct edge proxy only. CDN/load-balancer trust and WebSockets are not configured.",
      "Bind the application or Docker published port to 127.0.0.1; this candidate does not change ports or firewalls.",
      "Dot paths (including .well-known) are blocked; certificate renewal and application exceptions require explicit review.",
      "No static/PHP mode, CSP, HSTS, rate limiting, or default-host rejection. Review the complete server configuration.",
      "Proxy rules cannot prevent application vulnerabilities or secrets already bundled into client JavaScript.",
    ],
    activationChecklist: [
      "Inspect existing sites, certificate renewal method, permissions, and duplicate listen/server_name entries.",
      "Back up the current configuration and record a tested recovery path; preserve Certbot-managed configuration.",
      "Review the exact candidate diff and approve the target explicitly before any privileged changes.",
      "Validate the full candidate configuration with nginx -t in a staging configuration context before activation.",
      "After approved installation, run nginx -t against the active configuration before a graceful reload.",
      "Check HTTPS identity, redirects, application health, and blocked paths; restore and validate the backup on failure.",
    ],
  };
}
