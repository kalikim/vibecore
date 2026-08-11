import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Plan } from "@vibecore/contracts";
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
});
