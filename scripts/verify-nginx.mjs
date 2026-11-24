import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { createNginxPlan } from "../packages/deployment/dist/nginx.js";

// Pinned integration fixture, not a recommendation for a production image.
const image = "nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10";
const directory = await mkdtemp(join(tmpdir(), "vibecore-nginx-test-"));
const name = `vibecore-nginx-test-${randomUUID()}`;
let created = false;
function run(command, args, expected = 0) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 60_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, expected, `${command} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function docker(args, expected = 0) { return run("docker", args, expected); }
async function eventually(check) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { return await check(); } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError;
}
function get(port, ca, path = "/", headers = {}, body) {
  return new Promise((resolve, reject) => {
    const request = (ca ? httpsRequest : httpRequest)({
      hostname: "127.0.0.1", port, path, method: body ? "POST" : "GET",
      ...(ca ? { ca, servername: "app.example.test" } : {}),
      headers: { Host: "app.example.test", ...headers }, timeout: 3000,
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on("timeout", () => request.destroy(new Error("Request timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

try {
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=app.example.test", "-addext", "subjectAltName=DNS:app.example.test",
    "-keyout", join(directory, "privkey.pem"), "-out", join(directory, "fullchain.pem")]);
  const candidate = createNginxPlan({ domain: "app.example.test", port: 3000 }).config;
  // Exercise the exact candidate. Only the surrounding test harness is synthetic.
  const configuration = `pid /tmp/nginx.pid;
error_log /dev/stderr;
events {}
http {
  access_log off;
  proxy_temp_path /tmp/proxy;
  client_body_temp_path /tmp/body;
  fastcgi_temp_path /tmp/fastcgi;
  uwsgi_temp_path /tmp/uwsgi;
  scgi_temp_path /tmp/scgi;
  server {
    listen 127.0.0.1:3000;
    location / {
      return 200 '$http_host|$http_x_forwarded_for|$http_x_forwarded_proto|$http_forwarded';
    }
  }
  ${candidate}
}`;
  await writeFile(join(directory, "nginx.conf"), configuration, { mode: 0o600 });
  docker(["create", "--name", name, "--user", `${process.getuid()}:${process.getgid()}`, "--read-only", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m",
    "--publish", "127.0.0.1::80", "--publish", "127.0.0.1::443",
    "--mount", `type=bind,src=${directory},dst=/fixture,readonly`,
    "--mount", `type=bind,src=${directory},dst=/etc/letsencrypt/live/app.example.test,readonly`,
    "--entrypoint", "nginx", image, "-c", "/fixture/nginx.conf", "-g", "daemon off;"]);
  created = true;
  docker(["start", name]);
  docker(["exec", name, "nginx", "-t", "-c", "/fixture/nginx.conf"]);
  const port = (containerPort) => Number(docker(["port", name, `${containerPort}/tcp`]).split(":").at(-1));
  const tlsPort = port(443);
  const httpPort = port(80);
  const ca = await readFile(join(directory, "fullchain.pem"));
  const response = await eventually(() => get(tlsPort, ca, "/", { "X-Forwarded-For": "spoofed", "X-Forwarded-Proto": "http", Forwarded: "spoofed" }));
  assert.equal(response.status, 200);
  assert.match(response.text, /^app\.example\.test\|[0-9.]+\|https\|$/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  for (const path of ["/.env", "/.git/config", "/%2eenv", "/nested/.secret", "/node_modules/pkg", "/VENDOR/autoload.php"]) {
    assert.equal((await get(tlsPort, ca, path)).status, 404, path);
  }
  const redirect = await get(httpPort, undefined, "/hello?x=1", { Host: "untrusted.example" });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, "https://app.example.test/hello?x=1");
  assert.equal((await get(tlsPort, ca, "/", { "Content-Length": String(1024 * 1024 + 1) }, "x")).status, 413);
  // Invalid candidate must fail nginx -t. A failed reload must keep serving the old config.
  await writeFile(join(directory, "nginx.conf"), configuration + "\ninvalid_directive;\n");
  docker(["exec", name, "nginx", "-t", "-c", "/fixture/nginx.conf"], 1);
  docker(["kill", "--signal", "HUP", name]);
  await eventually(() => {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8", timeout: 5000 });
    assert.equal(logs.status, 0);
    assert.match(logs.stderr, /unknown directive "invalid_directive"/);
  });
  assert.equal((await get(tlsPort, ca)).status, 200);
  // Verify successful reload observably, not merely a successful signal command.
  await writeFile(join(directory, "nginx.conf"), configuration.replace("strict-origin-when-cross-origin", "same-origin"));
  docker(["exec", name, "nginx", "-t", "-c", "/fixture/nginx.conf"]);
  docker(["kill", "--signal", "HUP", name]);
  await eventually(async () => assert.equal((await get(tlsPort, ca)).headers["referrer-policy"], "same-origin"));
  await writeFile(join(directory, "nginx.conf"), configuration);
  docker(["exec", name, "nginx", "-t", "-c", "/fixture/nginx.conf"]);
  docker(["kill", "--signal", "HUP", name]);
  await eventually(async () => assert.equal((await get(tlsPort, ca)).headers["referrer-policy"], "strict-origin-when-cross-origin"));
  console.log("Nginx integration passed: trusted test TLS, proxy headers, redirects, blocked paths, body limit, invalid-config rejection, failed reload survival, restored configuration.");
} catch (error) {
  if (created) {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8", timeout: 5000 });
    console.error(logs.stdout, logs.stderr);
  }
  throw error;
} finally {
  // Remove only this invocation's uniquely named container and generated fixtures.
  if (created) docker(["rm", "--force", name]);
  await rm(directory, { recursive: true, force: true });
}
