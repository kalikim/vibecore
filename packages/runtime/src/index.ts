import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  DevProcessRecord,
  DevProcessStatus,
  DevResourceRecord,
  DevSessionRecord,
  VibecoreManifest,
} from "@vibecore/contracts";
import { buildProjectGraph, topologicalApplications } from "@vibecore/project-graph";
import { resolveEnvironment, valuesForApplication } from "@vibecore/environment";
import { startComposeSession, type CommandRunner, type ComposeSession } from "./compose.js";

export { startComposeSession, runCommand } from "./compose.js";
export type { CommandRunner, CommandResult, ComposeSession } from "./compose.js";

export interface CommandSpec {
  executable: string;
  args: string[];
}

export interface DevLogEvent {
  application: string;
  stream: "stdout" | "stderr" | "system";
  message: string;
}

export interface DevSession {
  readonly record: DevSessionRecord;
  stop(): Promise<void>;
  wait(): Promise<void>;
}

export interface DevSessionOptions {
  onLog?: (event: DevLogEvent) => void;
  healthTimeoutMs?: number;
  stopTimeoutMs?: number;
  composeTimeoutSeconds?: number;
  environmentName?: string;
  keepResources?: boolean;
  commandRunner?: CommandRunner;
}

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  record: DevProcessRecord;
}

export function parseCommand(command: string): CommandSpec {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  if (/[\n\r`]|\$\(/.test(command)) {
    throw new Error("Command contains unsupported shell syntax");
  }

  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    if (/[|;&<>]/.test(character)) {
      throw new Error("Command contains unsupported shell operators");
    }
    token += character;
  }

  if (escaped || quote) throw new Error("Command contains an incomplete escape or quote");
  if (token) tokens.push(token);
  const [executable, ...args] = tokens;
  if (!executable) throw new Error("Command cannot be empty");
  return { executable, args };
}

export async function allocateStablePort(
  application: string,
  reserved: Set<number> = new Set(),
): Promise<number> {
  const start = 4100 + (createHash("sha256").update(application).digest().readUInt16BE(0) % 800);
  for (let offset = 0; offset < 800; offset += 1) {
    const port = 4100 + ((start - 4100 + offset) % 800);
    if (!reserved.has(port) && await portAvailable(port)) return port;
  }
  throw new Error("No development port is available in the Vibecore range 4100-4899");
}

export async function startDevSession(
  manifest: VibecoreManifest,
  repositoryRoot: string,
  options: DevSessionOptions = {},
): Promise<DevSession> {
  const root = resolve(repositoryRoot);
  const environmentName = options.environmentName ?? "local";
  const environment = await resolveEnvironment(manifest, root, environmentName);
  const environmentErrors = environment.diagnostics.filter(({ severity }) => severity === "error");
  if (environmentErrors.length > 0) {
    throw new Error(environmentErrors.map(({ message }) => message).join("; "));
  }
  const graph = buildProjectGraph(manifest);
  const graphErrors = graph.diagnostics.filter(({ severity }) => severity === "error");
  if (graphErrors.length > 0) throw new Error(graphErrors.map(({ message }) => message).join("; "));

  const order = topologicalApplications(graph);
  if (order.length !== Object.keys(manifest.applications).length) {
    throw new Error("Unable to determine a safe application startup order");
  }

  const sessionId = `dev-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const now = new Date().toISOString();
  const record: DevSessionRecord = {
    apiVersion: "vibecore.dev/session/v1alpha1",
    id: sessionId,
    repositoryRoot: root,
    createdAt: now,
    updatedAt: now,
    status: "starting",
    resources: [],
    processes: [],
  };
  const sessionWriter = new SessionWriter(root, record);
  const managed: ManagedProcess[] = [];
  const reservedPorts = new Set<number>();
  let stopping = false;
  let stopPromise: Promise<void> | undefined;
  let compose: ComposeSession | undefined;

  const secretValues = Object.entries(manifest.variables ?? {})
    .filter(([, variable]) => variable.secret)
    .map(([name]) => environment.values[name])
    .filter((value): value is string => Boolean(value));
  const emit = (application: string, stream: DevLogEvent["stream"], message: string) => {
    options.onLog?.({ application, stream, message: redactMessage(message, secretValues) });
  };

  try {
    await sessionWriter.write();
    const composeResourceName = Object.entries(manifest.resources ?? {})
      .find(([, resource]) => resource.provider === "docker-compose")?.[0]
      ?? "local-services";
    compose = await startComposeSession(
      manifest,
      root,
      { ...process.env, ...environment.values },
      {
        ...(options.commandRunner ? { runner: options.commandRunner } : {}),
        timeoutSeconds: options.composeTimeoutSeconds ?? 60,
        onOutput: (stream, message) => emit(composeResourceName, stream, message),
        redactValues: secretValues,
      },
    );
    if (compose) {
      const resourceRecord: DevResourceRecord = {
        name: composeResourceName,
        provider: "docker-compose",
        projectName: compose.projectName,
        status: "ready",
      };
      record.resources.push(resourceRecord);
      await sessionWriter.write();
      emit(composeResourceName, "system", `resources ready under project ${compose.projectName}`);
    }

    for (const applicationName of order) {
      const application = manifest.applications[applicationName];
      if (!application) continue;
      const devCommand = application.commands?.dev;
      if (!devCommand) {
        throw new Error(`${applicationName} does not declare commands.dev`);
      }
      const command = parseCommand(devCommand);
      const port = await allocateStablePort(applicationName, reservedPorts);
      reservedPorts.add(port);
      const child = spawn(command.executable, command.args, {
        cwd: resolve(root, application.path),
        env: {
          ...process.env,
          ...valuesForApplication(manifest, applicationName, environment.values),
          PORT: String(port),
          VIBE_PORT: String(port),
          VIBE_ENVIRONMENT: environmentName,
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      await new Promise<void>((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
      if (!child.pid) throw new Error(`Unable to start ${applicationName}`);

      const processRecord: DevProcessRecord = {
        application: applicationName,
        pid: child.pid,
        port,
        status: "starting",
      };
      record.processes.push(processRecord);
      managed.push({ child, record: processRecord });
      pipeLines(child.stdout, (message) => emit(applicationName, "stdout", message));
      pipeLines(child.stderr, (message) => emit(applicationName, "stderr", message));
      child.once("error", (error) => emit(applicationName, "system", `process error: ${error.message}`));
      await sessionWriter.write();

      if (application.health?.path) {
        await waitForHealth(
          `http://127.0.0.1:${port}${application.health.path}`,
          child,
          application.health.timeoutSeconds
            ? application.health.timeoutSeconds * 1000
            : options.healthTimeoutMs ?? 15_000,
        );
        await updateProcess(sessionWriter, processRecord, "healthy");
        emit(applicationName, "system", `healthy on http://127.0.0.1:${port}${application.health.path}`);
      } else {
        await ensureRunning(child, 250);
        await updateProcess(sessionWriter, processRecord, "running");
        emit(applicationName, "system", `running on port ${port}`);
      }
    }
    record.status = "running";
    await sessionWriter.write();
  } catch (error) {
    record.status = "failed";
    await sessionWriter.write();
    await stopManagedProcesses(managed, sessionWriter, options.stopTimeoutMs ?? 3_000);
    if (compose && !options.keepResources) {
      await stopCompose(compose, record.resources[0], sessionWriter);
    }
    throw error;
  }

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (stopping) return;
      stopping = true;
      record.status = "stopping";
      await sessionWriter.write();
      await stopManagedProcesses(managed, sessionWriter, options.stopTimeoutMs ?? 3_000);
      if (compose && !options.keepResources) {
        await stopCompose(compose, record.resources[0], sessionWriter);
      }
      record.status = "stopped";
      await sessionWriter.write();
    })();
    return stopPromise;
  };

  const wait = async (): Promise<void> => {
    const exits = managed.map(({ child, record: processRecord }) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return stopping
          ? Promise.resolve()
          : Promise.reject(new Error(
            `${processRecord.application} exited unexpectedly with ${child.signalCode ?? `code ${child.exitCode ?? "unknown"}`}`,
          ));
      }
      return new Promise<void>((resolveExit, rejectExit) => {
        child.once("exit", (code, signal) => {
          if (stopping) resolveExit();
          else rejectExit(new Error(`${processRecord.application} exited unexpectedly with ${signal ?? `code ${code ?? "unknown"}`}`));
        });
      });
    });
    try {
      await Promise.all(exits);
    } catch (error) {
      record.status = "failed";
      await sessionWriter.write();
      await stop();
      throw error;
    }
  };

  return { record, stop, wait };
}

async function stopCompose(
  compose: ComposeSession,
  resource: DevResourceRecord | undefined,
  writer: SessionWriter,
): Promise<void> {
  if (resource) {
    resource.status = "stopping";
    await writer.write();
  }
  try {
    await compose.stop();
    if (resource) resource.status = "stopped";
  } catch (error) {
    if (resource) resource.status = "failed";
    throw error;
  } finally {
    await writer.write();
  }
}

class SessionWriter {
  private readonly directory: string;
  private readonly path: string;

  constructor(repositoryRoot: string, private readonly record: DevSessionRecord) {
    this.directory = resolve(repositoryRoot, ".vibecore", "sessions");
    this.path = join(this.directory, `${record.id}.json`);
  }

  async write(): Promise<void> {
    await ensureSafeDirectory(resolve(this.directory, ".."));
    await ensureSafeDirectory(this.directory);
    this.record.updatedAt = new Date().toISOString();
    const temporary = join(this.directory, `.${this.record.id}-${process.pid}.tmp`);
    await writeFile(temporary, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

async function updateProcess(
  writer: SessionWriter,
  record: DevProcessRecord,
  status: DevProcessStatus,
): Promise<void> {
  record.status = status;
  await writer.write();
}

async function stopManagedProcesses(
  managed: ManagedProcess[],
  writer: SessionWriter,
  timeoutMs: number,
): Promise<void> {
  for (const process of [...managed].reverse()) {
    if (process.child.exitCode !== null || process.child.signalCode !== null) {
      await updateProcess(writer, process.record, "stopped");
      continue;
    }
    await updateProcess(writer, process.record, "stopping");
    process.child.kill("SIGTERM");
    const exited = await waitForExit(process.child, timeoutMs);
    if (!exited) {
      process.child.kill("SIGKILL");
      await waitForExit(process.child, 1_000);
    }
    await updateProcess(writer, process.record, "stopped");
  }
}

async function waitForHealth(url: string, child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Process exited before health check succeeded: ${url}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The service may still be starting.
    }
    await delay(150);
  }
  throw new Error(`Health check timed out: ${url}`);
}

async function ensureRunning(child: ChildProcessWithoutNullStreams, graceMs: number): Promise<void> {
  await delay(graceMs);
  if (child.exitCode !== null) throw new Error(`Process exited during startup with code ${child.exitCode}`);
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

function pipeLines(stream: NodeJS.ReadableStream, emit: (message: string) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line) emit(line);
  });
  stream.on("end", () => {
    if (buffer) emit(buffer);
  });
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePort(true));
    });
  });
}

async function ensureSafeDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`${path} must be a real directory, not a link or file`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await mkdir(path, { mode: 0o700, recursive: false });
      return;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function redactMessage(message: string, values: string[]): string {
  let result = message;
  for (const value of [...new Set(values)].sort((left, right) => right.length - left.length)) {
    result = result.split(value).join("[REDACTED]");
  }
  return result;
}
