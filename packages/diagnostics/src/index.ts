import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic, VibecoreManifest } from "@vibecore/contracts";

export async function diagnoseProject(
  manifest: VibecoreManifest,
  repositoryRoot: string,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];

  for (const [name, application] of Object.entries(manifest.applications)) {
    const applicationPath = resolve(repositoryRoot, application.path);

    try {
      await access(applicationPath);
      diagnostics.push({
        code: "application.path.available",
        severity: "info",
        component: name,
        message: `${name} path is available`,
        evidence: [{ source: application.path, detail: applicationPath }],
      });
    } catch {
      diagnostics.push({
        code: "application.path.missing",
        severity: "error",
        component: name,
        message: `${name} path does not exist: ${application.path}`,
        evidence: [{ source: application.path, detail: applicationPath }],
      });
    }
  }

  for (const [name, application] of Object.entries(manifest.applications)) {
    for (const dependency of application.dependsOn ?? []) {
      const exists =
        dependency in manifest.applications || dependency in (manifest.resources ?? {});

      if (!exists) {
        diagnostics.push({
          code: "dependency.reference.missing",
          severity: "error",
          component: name,
          message: `${name} depends on unknown component: ${dependency}`,
        });
      }
    }
  }

  return diagnostics;
}

export function hasDiagnosticErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
