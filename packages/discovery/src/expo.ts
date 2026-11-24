import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Diagnostic } from "@codexsafari/vibecore-contracts";

export interface ExpoProfileInspection {
  name: string;
  channel?: string;
  distribution?: string;
}

export interface ExpoInspection {
  applicationPath: string;
  easPath?: string;
  appConfigPath?: string;
  profiles: ExpoProfileInspection[];
  publicVariableNames: string[];
  diagnostics: Diagnostic[];
}

export async function inspectExpoProject(repositoryRoot: string, applicationPath = "apps/mobile"): Promise<ExpoInspection> {
  const root = resolve(repositoryRoot);
  const appPath = safeInside(root, applicationPath);
  const diagnostics: Diagnostic[] = [];
  const eas = await readJson(join(root, appPath, "eas.json"));
  const appJson = await readJson(join(root, appPath, "app.json"));
  const appConfig = appJson && typeof appJson === "object" && !Array.isArray(appJson) && "expo" in appJson
    ? (appJson as { expo?: Record<string, unknown> }).expo
    : appJson && typeof appJson === "object" && !Array.isArray(appJson) ? appJson as Record<string, unknown> : undefined;
  const profiles = easProfiles(eas);
  const extra = appConfig?.extra && typeof appConfig.extra === "object" && appConfig.extra !== null ? appConfig.extra as Record<string, unknown> : undefined;
  const publicVariableNames = collectPublicNames(appConfig, extra);
  if (!eas) {
    diagnostics.push({ code: "expo.eas.missing", severity: "warning", component: "expo", message: `No eas.json was found at ${appPath}; EAS build profiles cannot be validated.` });
  } else if (profiles.length === 0) {
    diagnostics.push({ code: "expo.eas.no_profiles", severity: "warning", component: "expo", message: "eas.json does not declare build profiles." });
  }
  const production = profiles.find((profile) => profile.name === "production");
  if (production && !production.channel) {
    diagnostics.push({ code: "expo.eas.production_channel_missing", severity: "error", component: "expo", message: "The production EAS profile has no update channel." });
  }
  if (production?.distribution === "internal") {
    diagnostics.push({ code: "expo.eas.production_internal", severity: "warning", component: "expo", message: "The production EAS profile uses internal distribution; store builds usually use store distribution." });
  }
  const preview = profiles.find((profile) => profile.name === "preview" || profile.name === "staging");
  if (preview && production && preview.channel && preview.channel === production.channel) {
    diagnostics.push({ code: "expo.eas.channel_collision", severity: "error", component: "expo", message: "Preview and production EAS profiles share an update channel." });
  }
  if (!publicVariableNames.includes("EXPO_PUBLIC_API_URL")) {
    diagnostics.push({ code: "expo.public_api_url.missing", severity: "info", component: "expo", message: "No EXPO_PUBLIC_API_URL contract was found; mobile clients may not know which API environment to call." });
  }
  if (JSON.stringify(eas ?? {}).toLowerCase().includes("secret") || JSON.stringify(appConfig ?? {}).toLowerCase().includes("password")) {
    diagnostics.push({ code: "expo.secret_literal", severity: "warning", component: "expo", message: "EAS or app config appears to mention a secret or password field; keep values out of committed Expo config." });
  }
  return {
    applicationPath: appPath,
    ...(eas ? { easPath: join(appPath, "eas.json") } : {}),
    ...(appJson ? { appConfigPath: join(appPath, "app.json") } : {}),
    profiles,
    publicVariableNames,
    diagnostics,
  };
}

function easProfiles(document: unknown): ExpoProfileInspection[] {
  if (!document || typeof document !== "object" || Array.isArray(document)) return [];
  const build = (document as { build?: unknown }).build;
  if (!build || typeof build !== "object" || Array.isArray(build)) return [];
  return Object.entries(build as Record<string, unknown>).map(([name, value]) => {
    const profile = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
      name,
      ...(typeof profile.channel === "string" ? { channel: profile.channel } : {}),
      ...(typeof profile.distribution === "string" ? { distribution: profile.distribution } : {}),
    };
  });
}

function collectPublicNames(appConfig: Record<string, unknown> | undefined, extra: Record<string, unknown> | undefined): string[] {
  const names = new Set<string>();
  for (const source of [appConfig, extra, extra?.eas && typeof extra.eas === "object" ? extra.eas as Record<string, unknown> : undefined]) {
    if (!source) continue;
    for (const key of Object.keys(source)) if (key.startsWith("EXPO_PUBLIC_")) names.add(key);
  }
  return [...names].sort();
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

function safeInside(root: string, path: string): string {
  if (isAbsolute(path) || path.includes("..")) throw new Error("Expo application path must be repository-relative");
  const resolved = resolve(root, path);
  const relation = relative(root, resolved);
  if (relation.startsWith("..") || isAbsolute(relation)) throw new Error("Expo application path escapes the repository");
  return relation === "" ? "." : relation;
}
