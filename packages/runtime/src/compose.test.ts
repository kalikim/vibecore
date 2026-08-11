import { describe, expect, it } from "vitest";
import type { VibecoreManifest } from "@vibecore/contracts";
import { startComposeSession, type CommandRunner } from "./compose.js";

const manifest: VibecoreManifest = {
  apiVersion: "vibecore.dev/v1alpha1",
  kind: "Application",
  metadata: { name: "Compose Test" },
  applications: { api: { type: "api", framework: "hono", path: "apps/api" } },
  resources: {
    services: { type: "runtime", provider: "docker-compose", config: { file: "compose.yaml" } },
  },
  environments: { local: { runtime: "docker-compose" } },
};

describe("Docker Compose runtime", () => {
  it("uses a scoped project, waits for readiness, and preserves volumes on cleanup", async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const runner: CommandRunner = async (executable, args) => {
      calls.push({ executable, args });
      return { exitCode: 0, stdout: "ready\n", stderr: "" };
    };
    const session = await startComposeSession(manifest, "/project", {}, { runner });
    await session?.stop();

    expect(calls[0]).toEqual({ executable: "docker", args: ["info", "--format", "{{.ServerVersion}}"] });
    expect(calls[1]?.args).toContain("--wait");
    expect(calls[1]?.args).toContain("--project-name");
    expect(calls[2]?.args.slice(-2)).toEqual(["down", "--remove-orphans"]);
    expect(calls[2]?.args).not.toContain("--volumes");
  });

  it("cleans up its project when readiness fails", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_executable, args) => {
      calls.push(args);
      if (args.includes("up")) return { exitCode: 1, stdout: "", stderr: "service unhealthy" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await expect(startComposeSession(manifest, "/project", {}, { runner })).rejects.toThrow("failed to become ready");
    expect(calls.at(-1)?.slice(-2)).toEqual(["down", "--remove-orphans"]);
  });

  it("redacts declared secret values from output and failures", async () => {
    const output: string[] = [];
    const runner: CommandRunner = async (_executable, args) => {
      if (args.includes("up")) {
        return { exitCode: 1, stdout: "", stderr: "database rejected super-secret-value" };
      }
      return { exitCode: 0, stdout: "docker super-secret-value", stderr: "" };
    };
    await expect(startComposeSession(manifest, "/project", {}, {
      runner,
      redactValues: ["super-secret-value"],
      onOutput: (_stream, message) => output.push(message),
    })).rejects.toThrow("database rejected [REDACTED]");
    expect(output.join(" ")).not.toContain("super-secret-value");
  });
});
