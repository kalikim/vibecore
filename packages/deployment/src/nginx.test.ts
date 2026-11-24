import { describe, expect, it } from "vitest";
import { createNginxPlan } from "./nginx.js";

describe("Nginx candidate", () => {
  it("generates deterministic TLS-only proxy candidates with constrained forwarding", () => {
    const plan = createNginxPlan({ domain: "App.Example.com", port: 3000 });
    expect(plan).toEqual(createNginxPlan({ domain: "app.example.com", port: 3000 }));
    expect(plan.status).toBe("unvalidated");
    expect(plan.config).toContain("return 308 https://app.example.com$request_uri;");
    expect(plan.config).toContain("proxy_pass http://127.0.0.1:3000;");
    expect(plan.config).toContain("ssl_protocols TLSv1.2 TLSv1.3;");
    expect(plan.config).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(plan.config).toContain('proxy_set_header Forwarded "";');
    expect(plan.config).toContain("location ~ (^|/)\\. { return 404; }");
    expect(plan.digest).not.toBe(createNginxPlan({ domain: "app.example.com", port: 3001 }).digest);
  });
  it.each(["example.com;", "example.com\n}", "*.example.com", "https://example.com", "example.com/a", "example.com:443", "127.0.0.1", "localhost", "-bad.example.com", "x..com", `${"a".repeat(64)}.com`])("rejects invalid domain %s", (domain) => {
    expect(() => createNginxPlan({ domain, port: 3000 })).toThrow();
  });
  it.each([0, 80, 443, 1023, 65536, 3000.5, NaN, Infinity])("rejects invalid port %s", (port) => {
    expect(() => createNginxPlan({ domain: "example.com", port })).toThrow();
  });
});
