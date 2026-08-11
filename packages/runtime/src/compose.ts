import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { VibecoreManifest } from "@vibecore/contracts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export interface ComposeSession {
  projectName: string;
  file: string;
  stop(): Promise<void>;
}

export async function startComposeSession(
  manifest: VibecoreManifest,
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
  options: {
    runner?: CommandRunner;
    timeoutSeconds?: number;
    onOutput?: (stream: "stdout" | "stderr", message: string) => void;
    redactValues?: string[];
  } = {},
): Promise<ComposeSession | undefined> {
  const composeResource = Object.values(manifest.resources ?? {})
    .find(({ provider }) => provider === "docker-compose");
  const localRuntimeUsesCompose = Object.values(manifest.environments)
    .some(({ runtime }) => runtime === "docker-compose");
  if (!composeResource && !localRuntimeUsesCompose) return undefined;

  const root = resolve(repositoryRoot);
  const configuredFile = composeResource?.config?.file;
  if (configuredFile !== undefined && typeof configuredFile !== "string") {
    throw new Error("Docker Compose resource config.file must be a string");
  }
  const file = configuredFile ?? await findComposeFile(root);
  if (!file) throw new Error("Docker Compose runtime is declared, but no Compose file was found");
  const absoluteFile = resolve(root, file);
  const runner = options.runner ?? runCommand;
  const projectName = composeProjectName(manifest.metadata.name, root);
  const baseArgs = ["compose", "--project-name", projectName, "--file", absoluteFile];

  const info = await runner("docker", ["info", "--format", "{{.ServerVersion}}"], {
    cwd: root,
    env: environment,
  });
  emitResult(info, options.onOutput, options.redactValues ?? []);
  if (info.exitCode !== 0) {
    throw new Error("Docker daemon is unavailable; start Docker and retry");
  }

  const up = await runner("docker", [
    ...baseArgs,
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    String(options.timeoutSeconds ?? 60),
  ], { cwd: root, env: environment });
  emitResult(up, options.onOutput, options.redactValues ?? []);
  if (up.exitCode !== 0) {
    await runner("docker", [...baseArgs, "down", "--remove-orphans"], {
      cwd: root,
      env: environment,
    });
    throw new Error(`Docker Compose failed to become ready${safeSuffix(up.stderr, options.redactValues ?? [])}`);
  }

  return {
    projectName,
    file,
    stop: async () => {
      const down = await runner("docker", [...baseArgs, "down", "--remove-orphans"], {
        cwd: root,
        env: environment,
      });
      emitResult(down, options.onOutput, options.redactValues ?? []);
      if (down.exitCode !== 0) {
        throw new Error(`Docker Compose cleanup failed${safeSuffix(down.stderr, options.redactValues ?? [])}`);
      }
    },
  };
}

export async function runCommand(
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = boundedAppend(stdout, chunk); });
    child.stderr.on("data", (chunk: string) => { stderr = boundedAppend(stderr, chunk); });
    child.once("error", rejectCommand);
    child.once("close", (code) => resolveCommand({ exitCode: code ?? 1, stdout, stderr }));
  });
}

function composeProjectName(applicationName: string, root: string): string {
  const name = applicationName.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 32);
  const suffix = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `vibecore-${name}-${suffix}`;
}

async function findComposeFile(root: string): Promise<string | undefined> {
  for (const file of ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]) {
    try {
      await access(join(root, file));
      return file;
    } catch {
      // Try the next conventional filename.
    }
  }
  return undefined;
}

function emitResult(
  result: CommandResult,
  emit: ((stream: "stdout" | "stderr", message: string) => void) | undefined,
  redactValues: string[],
): void {
  for (const line of result.stdout.split(/\r?\n/)) if (line) emit?.("stdout", redact(line, redactValues));
  for (const line of result.stderr.split(/\r?\n/)) if (line) emit?.("stderr", redact(line, redactValues));
}

function boundedAppend(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length > 64_000 ? combined.slice(-64_000) : combined;
}

function safeSuffix(stderr: string, redactValues: string[]): string {
  const lastLine = stderr.trim().split(/\r?\n/).at(-1);
  if (!lastLine) return "";
  return `: ${redact(lastLine.replace(/[\r\n]/g, " "), redactValues).slice(0, 300)}`;
}

function redact(message: string, values: string[]): string {
  let result = message;
  for (const value of [...new Set(values.filter(Boolean))].sort((left, right) => right.length - left.length)) {
    result = result.split(value).join("[REDACTED]");
  }
  return result;
}
