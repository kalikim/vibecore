import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const entry = process.env.VIBECORE_TEST_ENTRY
  ? resolve(process.env.VIBECORE_TEST_ENTRY)
  : fileURLToPath(new URL("../apps/cli/dist/index.js", import.meta.url));

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "vibecore-cli-smoke-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function run(cwd, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd, encoding: "utf8", timeout: 15_000,
    // Do not pass developer cloud credentials to a test CLI process.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NO_COLOR: "1" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, expectedStatus, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

test("installed entry exposes help and rejects unknown commands", async (t) => {
  const root = await workspace(t);
  assert.match(run(root, ["--help"]), /Local-first application orchestration/);
  assert.equal(run(root, ["--version"]).trim(), "0.1.0-alpha.1");
  run(root, ["not-a-real-command"], 1);
  assert.deepEqual(await readdir(root), []);
});

test("nginx candidate is read-only and rejects injection and apply flags", async (t) => {
  const root = await workspace(t);
  const args = ["deploy", "nginx", "--domain", "app.example.com", "--port", "3000", "--json"];
  const plan = JSON.parse(run(root, args));
  assert.equal(plan.status, "unvalidated");
  assert.match(plan.config, /127\.0\.0\.1:3000/);
  run(root, [...args, "--apply"], 1);
  run(root, ["deploy", "nginx", "--domain", "example.com; injected", "--port", "3000"], 1);
  run(root, ["deploy", "nginx", "--domain", "example.com", "--port", "3e3"], 1);
  assert.deepEqual(await readdir(root), []);
});

test("plan is read-only by default and saved reports reject changed inputs", async (t) => {
  const root = await workspace(t);
  const args = ["plan", "--environment", "staging", "--budget-conscious", "--json"];
  const preview = JSON.parse(run(root, args));
  assert.equal(preview.plan.kind, "advisory");
  assert.equal(preview.plan.resourcePolicy.estimatedCloudCost, "unknown");
  assert.deepEqual(await readdir(root), []);
  const saved = JSON.parse(run(root, [...args, "--save"]));
  assert.equal(saved.plan.digest, preview.plan.digest);
  assert.equal(JSON.parse(run(root, [...args, "--check", saved.savedPath])).freshness, "matches-inspected-inputs");
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "changed", dependencies: { hono: "1.0.0" } }));
  const output = run(root, [...args, "--check", saved.savedPath], 1);
  assert.match(output, /plan.unavailable/);
  run(root, ["plan", "--apply"], 1);
});

test("plan fails closed on invalid manifests without leaking parser input", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "vibecore.yaml"), "token: [super-sensitive-value\n");
  const output = run(root, ["plan", "--json"], 1);
  assert.match(output, /plan.unavailable/);
  assert.ok(!output.includes("super-sensitive-value"));
  assert.deepEqual(await readdir(root), ["vibecore.yaml"]);
});

test("deployment lease blocks mutation but not read-only discovery", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, ".vibecore", "deployment.lock"), { recursive: true });
  JSON.parse(run(root, ["deploy", "support", "--json"]));
  const output = run(root, ["deploy", "verify-health", "--release", "missing", "--url", "https://example.com", "--json"], 1);
  JSON.parse(output);
  assert.match(output, /already active or interrupted/);
  assert.deepEqual(await readdir(join(root, ".vibecore")), ["deployment.lock"]);
});

test("deployment lease is released after a handled command failure", async (t) => {
  const root = await workspace(t);
  const output = run(root, ["deploy", "verify-health", "--release", "missing", "--url", "https://example.com", "--json"], 1);
  assert.match(output, /Unknown release/);
  assert.deepEqual(await readdir(join(root, ".vibecore")), ["state.json"]);
  const state = JSON.parse(run(root, ["history", "--json"]));
  assert.equal(state.deploymentAttempts.length, 1);
  assert.equal(state.deploymentAttempts[0].status, "command-failed");
  assert.equal(state.deploymentAttempts[0].remoteOutcome, "unverified");
  assert.equal(state.deploymentAttempts[0].exitCode, 1);
  assert.ok(!JSON.stringify(state).includes("https://example.com"));
});

test("health verification cannot reopen a rolled-back release", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, ".vibecore"));
  const state = { apiVersion: "vibecore.dev/state/v1alpha1", plans: [], releases: [{ id: "old-release", status: "rolled-back" }] };
  const path = join(root, ".vibecore", "state.json");
  await writeFile(path, JSON.stringify(state));
  const output = run(root, ["deploy", "verify-health", "--release", "old-release", "--url", "https://example.com", "--json"], 1);
  assert.match(output, /cannot be reopened/);
  const updated = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(updated.releases, state.releases);
  assert.deepEqual(updated.plans, state.plans);
  assert.equal(updated.deploymentAttempts[0].status, "command-failed");
  assert.deepEqual(await readdir(join(root, ".vibecore")), ["state.json"]);
});

test("capability discovery emits JSON without creating project files", async (t) => {
  const root = await workspace(t);
  for (const args of [["languages"], ["db", "support"], ["deploy", "support"], ["api", "adapters"], ["init", "--list"]]) {
    const result = JSON.parse(run(root, [...args, "--json"]));
    assert.ok(result && typeof result === "object");
  }
  assert.deepEqual(await readdir(root), []);
});

test("init plans without writes and requires exact approval", async (t) => {
  const root = await workspace(t);
  const args = ["init", "--blueprint", "web-api", "--json"];
  const proposal = JSON.parse(run(root, args));
  assert.ok(proposal.plan.digest);
  assert.deepEqual(await readdir(root), []);
  run(root, [...args, "--write"], 2);
  assert.deepEqual(await readdir(root), []);
  run(root, [...args, "--write", "--approve", "wrong"], 1);
  assert.deepEqual(await readdir(root), []);
  const applied = JSON.parse(run(root, [...args, "--write", "--approve", proposal.plan.digest]));
  assert.equal(applied.execution.status, "succeeded");
  const manifest = await readFile(join(root, "vibecore.yaml"), "utf8");
  assert.match(manifest, /production:/);
  run(root, [...args, "--write", "--approve", proposal.plan.digest], 1);
  assert.equal(await readFile(join(root, "vibecore.yaml"), "utf8"), manifest);
});

test("doctor validates with the shipped schema outside the source checkout", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "vibecore.yaml"), "apiVersion: invalid\nkind: Application\n");
  const output = run(root, ["doctor", "--json"], 1);
  JSON.parse(output);
  assert.match(output, /Invalid Vibecore manifest/);
  assert.doesNotMatch(output, /ENOENT|Cannot find/);
  assert.deepEqual(await readdir(root), ["vibecore.yaml"]);
});
