import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Plan, Release } from "@codexsafari/vibecore-contracts";
import { FileStateStore } from "./index.js";

const plan: Plan = {
  apiVersion: "vibecore.dev/plan/v1alpha1",
  id: "plan-secret-test",
  digest: "digest",
  createdAt: "2026-08-11T00:00:00.000Z",
  repositoryFingerprint: "repository",
  environment: "local",
  actions: [{
    id: "action",
    adapter: "test",
    operation: "test",
    summary: "test",
    risk: "write",
    dependsOn: [],
    inputs: { token: "must-not-be-persisted" },
    permissions: [],
  }],
};

describe("FileStateStore", () => {
  it("records command completion without asserting remote success", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-attempt-"));
    try {
      const store = new FileStateStore(root);
      const attempt = await store.startDeploymentAttempt("deploy azure");
      expect((await store.read()).deploymentAttempts).toEqual([attempt]);
      await store.finishDeploymentAttempt(attempt, 0);
      expect((await store.read()).deploymentAttempts?.[0]).toMatchObject({ status: "command-completed", remoteOutcome: "unverified", exitCode: 0 });
      await expect(store.finishDeploymentAttempt(attempt, 1)).rejects.toThrow("changed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects raw command arguments and invalid completion codes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-attempt-validation-"));
    try {
      const store = new FileStateStore(root);
      await expect(store.startDeploymentAttempt("deploy azure --token secret-value")).rejects.toThrow("command name");
      const attempt = await store.startDeploymentAttempt("expo build");
      await expect(store.finishDeploymentAttempt(attempt, -1)).rejects.toThrow("exit code");
      await store.finishDeploymentAttempt(attempt, 2);
      expect((await store.read()).deploymentAttempts?.[0]).toMatchObject({ status: "command-failed", remoteOutcome: "unverified", exitCode: 2 });
      expect(await readFile(join(root, ".vibecore/state.json"), "utf8")).not.toContain("secret-value");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves unresolved attempts across unrelated ledger writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-attempt-preserve-"));
    try {
      const store = new FileStateStore(root);
      const attempt = await store.startDeploymentAttempt("deploy aws");
      await store.start(plan);
      await store.recordRelease(testRelease("new-release"));
      expect((await new FileStateStore(root).read()).deploymentAttempts).toEqual([attempt]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retains running attempt evidence and the lease after process termination", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-attempt-crash-"));
    const entry = new URL("../dist/index.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { FileStateStore } from ${JSON.stringify(entry)};
      const store = new FileStateStore(process.argv[1]);
      await store.acquireDeploymentLease();
      await store.startDeploymentAttempt("deploy aws");
      console.log("ready");
      setInterval(() => {}, 1000);
    `, root], { stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Worker did not become ready")), 5000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Worker exited before readiness")); });
        child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
      });
      child.kill("SIGKILL");
      await closed;
      const store = new FileStateStore(root);
      expect((await store.read()).deploymentAttempts?.[0]).toMatchObject({ command: "deploy aws", status: "running", remoteOutcome: "unverified" });
      await expect(store.acquireDeploymentLease()).rejects.toThrow("active or interrupted");
    } finally {
      child.kill("SIGKILL");
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  it("rejects stale release updates and changes to release identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-release-cas-"));
    try {
      const store = new FileStateStore(root);
      const initial = testRelease("initial");
      await store.recordRelease(initial);
      const healthy = { ...initial, status: "healthy" as const };
      await store.updateRelease(healthy, initial);
      await expect(store.updateRelease({ ...initial, status: "failed" }, initial)).rejects.toThrow("Release changed");
      await expect(store.updateRelease({ ...healthy, providerResourceId: "other-target" }, healthy)).rejects.toThrow("identity");
      expect(await store.releases()).toEqual([healthy]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("commits both rollback records together while preserving unrelated releases", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-rollback-atomic-"));
    try {
      const store = new FileStateStore(root);
      const failed = { ...testRelease("failed"), status: "unhealthy" as const };
      const target = { ...testRelease("target"), status: "healthy" as const };
      const unrelated = testRelease("unrelated");
      for (const entry of [failed, target, unrelated]) await store.recordRelease(entry);
      const rolledBack = { ...failed, status: "rolled-back" as const };
      const rollback = { ...testRelease("rollback"), rollbackOf: failed.id };
      await store.commitRollback([failed, target], rolledBack, rollback);
      expect(await store.releases()).toEqual([rollback, unrelated, target, rolledBack]);
      const before = await store.read();
      await expect(store.commitRollback([failed, target], rolledBack, { ...rollback, id: "second" })).rejects.toThrow("Release changed");
      expect(await store.read()).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects rollback ID collisions without partially changing the failed release", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-rollback-collision-"));
    try {
      const store = new FileStateStore(root);
      const failed = testRelease("failed");
      const target = testRelease("target");
      await store.recordRelease(failed);
      await store.recordRelease(target);
      const before = await store.read();
      await expect(store.commitRollback([failed, target], { ...failed, status: "rolled-back" }, { ...target, rollbackOf: failed.id })).rejects.toThrow("already exists");
      expect(await store.read()).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("excludes overlapping deployment commands until the owner releases its lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-deployment-lease-"));
    try {
      const first = new FileStateStore(root);
      const second = new FileStateStore(root);
      const release = await first.acquireDeploymentLease();
      await expect(second.acquireDeploymentLease()).rejects.toThrow("already active or interrupted");
      expect(await readdir(join(root, ".vibecore"))).toEqual(["deployment.lock"]);
      await release();
      await release();
      const nextRelease = await second.acquireDeploymentLease();
      await nextRelease();
      expect(await readdir(join(root, ".vibecore"))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("times out without deleting or stealing an existing lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-state-locked-"));
    try {
      await mkdir(join(root, ".vibecore", "state.lock"), { recursive: true });
      await expect(new FileStateStore(root).start(plan)).rejects.toThrow("State ledger is locked");
      expect(await readdir(join(root, ".vibecore"))).toEqual(["state.lock"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 10_000);

  it("preserves simultaneous writes from independent store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-state-concurrent-"));
    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) =>
        new FileStateStore(root).start({ ...plan, id: `plan-${index}` })));
      expect((await new FileStateStore(root).read()).plans).toHaveLength(20);
      expect(await readdir(join(root, ".vibecore"))).toEqual(["state.json"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes writers in separate Node processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-state-processes-"));
    try {
      const entry = new URL("../dist/index.js", import.meta.url).href;
      const source = `import { FileStateStore } from ${JSON.stringify(entry)};
        const [root, prefix, serialized] = process.argv.slice(1);
        const store = new FileStateStore(root);
        const template = JSON.parse(serialized);
        for (let index = 0; index < 5; index++) await store.start({ ...template, id: prefix + index });`;
      await Promise.all(Array.from({ length: 4 }, (_, index) =>
        promisify(execFile)(process.execPath, ["--input-type=module", "-e", source, root, `worker-${index}-`, JSON.stringify(plan)], { timeout: 15_000 })));
      expect((await new FileStateStore(root).read()).plans).toHaveLength(20);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects duplicate active execution and releases the lock after rejection", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-state-duplicate-"));
    try {
      const store = new FileStateStore(root);
      const results = await Promise.allSettled([store.start(plan), store.start(plan)]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
      await store.finish(plan.id, "failed");
      expect((await store.read()).plans[0]?.status).toBe("failed");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("commits selected records atomically and preserves unrelated writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-state-cas-"));
    try {
      const store = new FileStateStore(root);
      await store.start(plan);
      const expected = await store.read();
      await store.start({ ...plan, id: "unrelated" });
      await store.compareAndSwapRecords(expected, { plans: expected.plans.map((entry) => ({ ...entry, status: "interrupted" })), releases: [] });
      const current = await store.read();
      expect(current.plans.find(({ id }) => id === "unrelated")?.status).toBe("executing");
      expect(current.plans.find(({ id }) => id === plan.id)?.status).toBe("interrupted");
      await expect(store.compareAndSwapRecords(expected, expected)).rejects.toThrow("State changed");
      expect(await store.read()).toEqual(current);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not partially commit when a later selected record changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-state-atomic-"));
    try {
      const store = new FileStateStore(root);
      await store.start(plan);
      await store.start({ ...plan, id: "second" });
      const expected = await store.read();
      await store.finish(plan.id, "succeeded");
      const current = await store.read();
      await expect(store.compareAndSwapRecords(expected, {
        plans: expected.plans.map((entry) => ({ ...entry, status: "interrupted" })), releases: [],
      })).rejects.toThrow("State changed");
      expect(await store.read()).toEqual(current);
      await expect(store.compareAndSwapRecords(current, { plans: [], releases: [] })).rejects.toThrow("same unique record IDs");
      expect(await store.read()).toEqual(current);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("records lifecycle metadata without persisting action inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-state-"));
    const store = new FileStateStore(root);
    await store.start(plan);
    await store.updateAction(plan.id, "action", "succeeded");
    await store.finish(plan.id, "succeeded");

    const state = await store.read();
    expect(state.plans[0]?.status).toBe("succeeded");
    const source = await readFile(join(root, ".vibecore/state.json"), "utf8");
    expect(source).not.toContain("must-not-be-persisted");
    expect(source).not.toContain("token");
  });

  it("normalizes stored errors to non-secret codes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-state-"));
    const store = new FileStateStore(root);
    await store.start(plan);
    await store.updateAction(plan.id, "action", "failed", "E ACCESS secret=value");
    expect((await store.read()).plans[0]?.actions[0]?.errorCode).toBe("EXECUTION_ERROR");
  });

  it("records and filters release metadata without credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-state-"));
    const store = new FileStateStore(root);
    const release: Release = { id: "release-one", application: "api", provider: "railway", mode: "git", environment: "staging", sourceRevision: "abcdef1", planDigest: "digest", status: "deploying", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" };
    await store.recordRelease(release);
    await store.updateRelease({ ...release, status: "healthy", updatedAt: "2026-08-21T00:01:00.000Z" }, release);
    expect(await store.releases({ provider: "railway" })).toHaveLength(1);
    expect(await store.releases({ provider: "azure" })).toHaveLength(0);
    expect(await readFile(join(root, ".vibecore/state.json"), "utf8")).not.toContain("secret");
  });
});

function testRelease(id: string): Release {
  return { id, application: "api", provider: "railway", mode: "git", environment: "staging", sourceRevision: "abcdef1", planDigest: "digest", status: "deploying", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z" };
}
