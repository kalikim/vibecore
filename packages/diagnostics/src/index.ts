import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { Diagnostic, VibecoreManifest } from "@vibecore/contracts";
import { scanRepository } from "@vibecore/discovery";
import { buildProjectGraph } from "@vibecore/project-graph";
import { resolveEnvironment } from "@vibecore/environment";

export async function diagnoseProject(
  manifest: VibecoreManifest,
  repositoryRoot: string,
  environmentName = "local",
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const scan = await scanRepository(repositoryRoot);
  diagnostics.push(...scan.diagnostics);
  diagnostics.push(...buildProjectGraph(manifest).diagnostics);
  const environment = await resolveEnvironment(manifest, repositoryRoot, environmentName);
  diagnostics.push(...environment.diagnostics);

  const requiredNodeMajor = 22;
  const currentNodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  diagnostics.push({
    code: currentNodeMajor >= requiredNodeMajor ? "runtime.node.supported" : "runtime.node.unsupported",
    severity: currentNodeMajor >= requiredNodeMajor ? "info" : "error",
    component: "runtime",
    message: currentNodeMajor >= requiredNodeMajor
      ? `Node.js ${process.versions.node} satisfies the supported baseline`
      : `Node.js ${process.versions.node} is unsupported; use Node.js ${requiredNodeMajor} or newer`,
    evidence: [{ source: "process.versions.node", detail: process.versions.node }],
  });

  if (manifest.workspace?.packageManager && scan.packageManager) {
    const matches = manifest.workspace.packageManager === scan.packageManager.name;
    diagnostics.push({
      code: matches ? "workspace.package-manager.matches" : "workspace.package-manager.mismatch",
      severity: matches ? "info" : "error",
      component: "workspace",
      message: matches
        ? `Package manager ${scan.packageManager.name} matches the manifest`
        : `Manifest declares ${manifest.workspace.packageManager}, but ${scan.packageManager.name} was detected`,
      evidence: scan.packageManager.evidence,
    });
  }

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

      const detected = scan.applications.find((candidate) => candidate.path === application.path);
      if (detected) {
        const matches = detected.framework === application.framework;
        diagnostics.push({
          code: matches ? "application.framework.matches" : "application.framework.mismatch",
          severity: matches ? "info" : "warning",
          component: name,
          message: matches
            ? `${name} framework ${application.framework} matches repository evidence`
            : `${name} declares ${application.framework}, but ${detected.framework} was detected`,
          evidence: detected.evidence,
        });
      }
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

  for (const [variableName, variable] of Object.entries(manifest.variables ?? {})) {
    for (const applicationName of variable.applications ?? []) {
      if (!(applicationName in manifest.applications)) {
        diagnostics.push({
          code: "variable.application.missing",
          severity: "error",
          component: variableName,
          message: `${variableName} references unknown application: ${applicationName}`,
        });
      }
    }
  }

  return diagnostics;
}

export function hasDiagnosticErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
