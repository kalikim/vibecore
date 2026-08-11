#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { stringify } from "yaml";
import { loadManifest, ManifestValidationError } from "@vibecore/config";
import type { Diagnostic } from "@vibecore/contracts";
import { diagnoseProject, hasDiagnosticErrors } from "@vibecore/diagnostics";
import { createManifestProposal, scanRepository } from "@vibecore/discovery";
import { applyAdoptionPlan } from "@vibecore/executor";
import { createAdoptionPlan } from "@vibecore/planner";
import { FileStateStore } from "@vibecore/state";
import { startDevSession } from "@vibecore/runtime";

const program = new Command()
  .name("vibe")
  .description("Local-first application orchestration")
  .version("0.0.0");

program
  .command("doctor")
  .description("Run read-only project diagnostics")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { manifest: string; json?: boolean }) => {
    const manifestPath = resolve(process.cwd(), options.manifest);

    try {
      const manifest = await loadManifest(manifestPath);
      const diagnostics = await diagnoseProject(manifest, process.cwd());
      printDiagnostics(diagnostics, options.json ?? false);
      process.exitCode = hasDiagnosticErrors(diagnostics) ? 1 : 0;
    } catch (error) {
      const diagnostic = toDiagnostic(error, manifestPath);
      printDiagnostics([diagnostic], options.json ?? false);
      process.exitCode = 1;
    }
  });

program
  .command("adopt")
  .description("Inspect an existing repository and propose a Vibecore manifest")
  .option("--json", "print machine-readable JSON")
  .option("--write", "create the manifest after digest approval")
  .option("--approve <digest>", "approve the exact generated plan digest")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .action(async (options: { json?: boolean; write?: boolean; approve?: string; manifest: string }) => {
    try {
      const scan = await scanRepository(process.cwd());
      const manifest = scan.applications.length > 0 ? createManifestProposal(scan) : null;
      const plan = manifest ? createAdoptionPlan(scan, manifest, options.manifest) : null;
      const proposal = { scan, manifest, plan };

      if (!options.json && (!manifest || !plan)) {
        console.log("# Vibecore could not create an adoption proposal. No files were changed.\n");
        printDiagnostics(scan.diagnostics, false);
      } else if (!options.json && manifest && plan) {
        console.log("# Read-only adoption proposal. No files were changed.\n");
        process.stdout.write(stringify(manifest, { lineWidth: 100 }));
        console.log(`\n# Plan: ${plan.id}`);
        console.log(`# Digest: ${plan.digest}`);
        console.log(`# Action: ${plan.actions[0]?.summary ?? "Create manifest"}`);
        if (scan.diagnostics.length > 0) {
          console.log("\n# Discovery diagnostics");
          printDiagnostics(scan.diagnostics, false);
        }
      }

      if (hasDiagnosticErrors(scan.diagnostics)) {
        if (options.json) printJson(proposal);
        process.exitCode = 1;
        return;
      }

      if (options.write && plan) {
        if (!options.approve) {
          if (options.json) {
            printJson(proposal);
          } else {
            console.log(`\nReview the plan, then apply it with:\n  vibe adopt --write --approve ${plan.digest}`);
          }
          process.exitCode = 2;
          return;
        }

        const currentScan = await scanRepository(process.cwd());
        const result = await applyAdoptionPlan(plan, {
          repositoryRoot: process.cwd(),
          approval: options.approve,
          currentRepositoryFingerprint: currentScan.fingerprint,
        });
        if (options.json) {
          printJson({ ...proposal, execution: result });
        } else {
          console.log(`\n✓ Applied ${result.appliedActions.length} action from ${result.planId}`);
        }
      } else if (options.json) {
        printJson(proposal);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic: Diagnostic = {
        code: "adoption.failed",
        severity: "error",
        component: "adoption",
        message,
      };
      printDiagnostics([diagnostic], options.json ?? false);
      process.exitCode = 1;
    }
  });

program
  .command("history")
  .description("Show the local redacted execution ledger")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const state = await new FileStateStore(process.cwd()).read();
      if (options.json) {
        printJson(state);
        return;
      }
      if (state.plans.length === 0) {
        console.log("No local executions have been recorded");
        return;
      }
      for (const plan of state.plans) {
        console.log(`${statusSymbol(plan.status)} ${plan.id}  ${plan.status}  ${plan.environment}  ${plan.updatedAt}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printDiagnostics([{
        code: "history.unavailable",
        severity: "error",
        component: "state",
        message,
      }], options.json ?? false);
      process.exitCode = 1;
    }
  });

program
  .command("dev")
  .description("Start and supervise declared local application processes")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .action(async (options: { manifest: string }) => {
    const manifestPath = resolve(process.cwd(), options.manifest);
    try {
      const manifest = await loadManifest(manifestPath);
      const session = await startDevSession(manifest, process.cwd(), {
        onLog: ({ application, stream, message }) => {
          const marker = stream === "stderr" ? "!" : stream === "system" ? "•" : "│";
          console.log(`${marker} ${application.padEnd(12)} ${message}`);
        },
      });
      console.log(`✓ Development session ${session.record.id} is running`);
      for (const process of session.record.processes) {
        console.log(`  ${process.application.padEnd(12)} http://127.0.0.1:${process.port}`);
      }

      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        console.log("\nStopping Vibecore development session...");
        void session.stop();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      await session.wait();
      await session.stop();
      console.log("✓ Development session stopped");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printDiagnostics([{
        code: "dev.failed",
        severity: "error",
        component: "runtime",
        message,
      }], false);
      process.exitCode = 1;
    }
  });

await program.parseAsync();

function toDiagnostic(error: unknown, manifestPath: string): Diagnostic {
  if (error instanceof ManifestValidationError) {
    return {
      code: "manifest.invalid",
      severity: "error",
      component: "manifest",
      message: error.message,
      evidence: [{ source: manifestPath, detail: `${error.issues.length} validation issue(s)` }],
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "manifest.unavailable",
    severity: "error",
    component: "manifest",
    message: `Unable to load manifest: ${message}`,
    evidence: [{ source: manifestPath, detail: manifestPath }],
  };
}

function printDiagnostics(diagnostics: Diagnostic[], json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
    return;
  }

  if (diagnostics.length === 0) {
    console.log("✓ No problems found");
    return;
  }

  const symbols = { info: "✓", warning: "!", error: "✗" } as const;
  for (const diagnostic of diagnostics) {
    console.log(`${symbols[diagnostic.severity]} [${diagnostic.code}] ${diagnostic.message}`);
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function statusSymbol(status: string): string {
  if (status === "succeeded") return "✓";
  if (status === "failed") return "✗";
  return "•";
}
