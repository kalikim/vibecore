import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { VibecoreManifest } from "@vibecore/contracts";
import { allocateStablePort, parseCommand, startDevSession } from "./index.js";

describe("runtime commands", () => {
  it("parses arguments without invoking a shell", () => {
    expect(parseCommand("pnpm --filter '@scope/web' dev")).toEqual({
      executable: "pnpm",
      args: ["--filter", "@scope/web", "dev"],
    });
    expect(() => parseCommand("pnpm dev && curl example.com")).toThrow("shell operators");
    expect(() => parseCommand("node $(dangerous)")).toThrow("shell syntax");
  });

  it("allocates a stable available port", async () => {
    const first = await allocateStablePort("web");
    const second = await allocateStablePort("web");
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(4100);
    expect(first).toBeLessThan(4900);
  });
});

describe("development sessions", () => {
  it("starts, health-checks, records, and stops only its child", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "vibecore-runtime-"));
    const serverPath = resolve(import.meta.dirname, "../../../fixtures/runtime/healthy-server.mjs");
    const manifest: VibecoreManifest = {
      apiVersion: "vibecore.dev/v1alpha1",
      kind: "Application",
      metadata: { name: "runtime-test" },
      applications: {
        api: {
          type: "api",
          framework: "node",
          path: ".",
          commands: { dev: `node ${serverPath}` },
          health: { path: "/health", timeoutSeconds: 5 },
        },
      },
      environments: { dev: { runtime: "local-process" } },
    };
    const logs: string[] = [];
    const session = await startDevSession(manifest, repositoryRoot, {
      onLog: ({ application, message }) => logs.push(`${application}:${message}`),
    });

    expect(session.record.status).toBe("running");
    expect(session.record.processes[0]?.status).toBe("healthy");
    expect(logs.some((line) => line.includes("healthy"))).toBe(true);
    await access(join(repositoryRoot, ".vibecore/sessions", `${session.record.id}.json`));

    await session.stop();
    expect(session.record.status).toBe("stopped");
    const persisted = JSON.parse(await readFile(
      join(repositoryRoot, ".vibecore/sessions", `${session.record.id}.json`),
      "utf8",
    )) as { status: string; processes: Array<{ status: string }> };
    expect(persisted.status).toBe("stopped");
    expect(persisted.processes[0]?.status).toBe("stopped");
  });
});
