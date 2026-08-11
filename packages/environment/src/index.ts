import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic, VibecoreManifest } from "@vibecore/contracts";

export interface EnvironmentResolution {
  name: string;
  values: Record<string, string>;
  diagnostics: Diagnostic[];
  sources: string[];
}

const publicPrefixes = ["NEXT_PUBLIC_", "NUXT_PUBLIC_", "VITE_", "EXPO_PUBLIC_"];

export async function resolveEnvironment(
  manifest: VibecoreManifest,
  repositoryRoot: string,
  environmentName = "local",
  processEnvironment: NodeJS.ProcessEnv = process.env,
): Promise<EnvironmentResolution> {
  const diagnostics: Diagnostic[] = [];
  const environment = manifest.environments[environmentName];
  if (!environment) {
    return {
      name: environmentName,
      values: {},
      sources: [],
      diagnostics: [{
        code: "environment.unknown",
        severity: "error",
        component: environmentName,
        message: `Environment is not declared: ${environmentName}`,
      }],
    };
  }

  const values: Record<string, string> = {};
  const sources: string[] = [];
  const usesEnvFiles = Object.values(environment.variableSources ?? {}).includes("env-file")
    || environmentName === "local";
  if (usesEnvFiles) {
    const files = [
      ".env",
      ".env.local",
      `.env.${environmentName}`,
      `.env.${environmentName}.local`,
    ];
    for (const file of files) {
      try {
        Object.assign(values, parseEnvFile(await readFile(join(repositoryRoot, file), "utf8")));
        sources.push(file);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
    }
  }

  for (const [name, value] of Object.entries(processEnvironment)) {
    if (value !== undefined) values[name] = value;
  }

  for (const [name, variable] of Object.entries(manifest.variables ?? {})) {
    const value = values[name];
    if (variable.required && (!value || value.trim() === "")) {
      diagnostics.push({
        code: "environment.variable.missing",
        severity: "error",
        component: name,
        message: `Required variable ${name} is missing for ${environmentName}`,
        evidence: [{ source: "vibecore.yaml#variables", detail: "required variable contract" }],
      });
    } else if (value !== undefined) {
      diagnostics.push({
        code: "environment.variable.available",
        severity: "info",
        component: name,
        message: `${name} is available for ${environmentName}`,
        evidence: [{ source: sourceFor(name, processEnvironment, sources), detail: "value redacted" }],
      });
    }

    if (variable.secret && publicPrefixes.some((prefix) => name.startsWith(prefix))) {
      diagnostics.push({
        code: "environment.secret.public-prefix",
        severity: "error",
        component: name,
        message: `Secret variable ${name} uses a client-exposed public prefix`,
        evidence: [{ source: "vibecore.yaml#variables", detail: "secret marked true" }],
      });
    }
  }

  return { name: environmentName, values, diagnostics, sources };
}

export function valuesForApplication(
  manifest: VibecoreManifest,
  applicationName: string,
  values: Record<string, string>,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [name, variable] of Object.entries(manifest.variables ?? {})) {
    if (!variable.applications || variable.applications.includes(applicationName)) {
      const value = values[name];
      if (value !== undefined) selected[name] = value;
    }
  }
  return selected;
}

export function parseEnvFile(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, originalLine] of source.split(/\r?\n/).entries()) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator < 1) throw new Error(`Invalid environment assignment on line ${index + 1}`);
    const name = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name on line ${index + 1}`);
    }
    let value = normalized.slice(separator + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(" #");
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    values[name] = value;
  }
  return values;
}

function sourceFor(name: string, processEnvironment: NodeJS.ProcessEnv, files: string[]): string {
  if (processEnvironment[name] !== undefined) return "process environment";
  return files.at(-1) ?? "environment source";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
