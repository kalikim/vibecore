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
import { diagnoseDatabaseStack, inspectPrismaDatabase, listDatabaseAdapters, runPrismaLiveCheck } from "@vibecore/database";
import type { DatabaseAdapterKind } from "@vibecore/contracts";

const program = new Command()
  .name("vibe")
  .description("Local-first application orchestration")
  .version("0.0.0");

program
  .command("doctor")
  .description("Run read-only project diagnostics")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("-e, --environment <name>", "environment to validate", "local")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { manifest: string; environment: string; json?: boolean }) => {
    const manifestPath = resolve(process.cwd(), options.manifest);

    try {
      const manifest = await loadManifest(manifestPath);
      const diagnostics = await diagnoseProject(manifest, process.cwd(), options.environment);
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
  .option("-e, --environment <name>", "environment to run", "local")
  .option("--keep-resources", "leave project-scoped local resources running after applications stop")
  .action(async (options: { manifest: string; environment: string; keepResources?: boolean }) => {
    const manifestPath = resolve(process.cwd(), options.manifest);
    try {
      const manifest = await loadManifest(manifestPath);
      const session = await startDevSession(manifest, process.cwd(), {
        environmentName: options.environment,
        keepResources: options.keepResources ?? false,
        onLog: ({ application, stream, message }) => {
          const marker = stream === "stderr" ? "!" : stream === "system" ? "•" : "│";
          console.log(`${marker} ${application.padEnd(12)} ${message}`);
        },
      });
      console.log(`✓ Development session ${session.record.id} is running`);
      for (const process of session.record.processes) {
        console.log(`  ${process.application.padEnd(12)} http://127.0.0.1:${process.port}`);
      }
      for (const resource of session.record.resources) {
        console.log(`  ${resource.name.padEnd(12)} ${resource.provider} (${resource.projectName})`);
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

const database = program.command("db").description("Inspect Prisma schema and migration safety without modifying a database");

database
  .command("support")
  .description("Show database engine, tooling, and hosted-provider adapter capabilities")
  .option("-k, --kind <kind>", "engine, tool, or provider")
  .option("--json", "print machine-readable JSON")
  .action((options: { kind?: string; json?: boolean }) => {
    if (options.kind && options.kind !== "engine" && options.kind !== "tool" && options.kind !== "provider") {
      printDatabaseError(new Error(`Unknown adapter kind ${JSON.stringify(options.kind)}; expected engine, tool, or provider`), options.json ?? false);
      return;
    }
    const adapters = listDatabaseAdapters(options.kind as DatabaseAdapterKind | undefined);
    if (options.json) {
      printJson({ adapters });
      return;
    }
    for (const adapter of adapters) {
      console.log(`\n${adapter.displayName} (${adapter.kind}:${adapter.id})`);
      console.log(`  Engines: ${adapter.engines.join(", ")}`);
      for (const capability of adapter.capabilities.filter(({ support }) => support !== "unsupported")) {
        console.log(`  ${supportSymbol(capability.support)} ${capability.capability.padEnd(20)} ${capability.support}`);
      }
    }
  });

database
  .command("doctor")
  .description("Validate a database engine, schema tool, and hosted-provider configuration")
  .requiredOption("--engine <engine>", "database engine, such as postgresql, mongodb, or redis")
  .option("--tool <tool>", "schema tool, such as prisma, drizzle, or mongoose")
  .option("--provider <provider>", "hosted provider, such as supabase, neon, or mongodb-atlas")
  .option("--json", "print machine-readable JSON")
  .action((options: { engine: string; tool?: string; provider?: string; json?: boolean }) => {
    const result = diagnoseDatabaseStack(options.engine, options.tool, options.provider, process.env);
    if (options.json) printJson(result);
    else printDiagnostics(result.diagnostics, false);
    process.exitCode = hasDiagnosticErrors(result.diagnostics) ? 1 : 0;
  });

database
  .command("inspect")
  .description("Inspect local Prisma migration files and classify their risk")
  .option("-s, --schema <path>", "Prisma schema path", "prisma/schema.prisma")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { schema: string; json?: boolean }) => {
    try {
      const inspection = await inspectPrismaDatabase(process.cwd(), options.schema);
      if (options.json) {
        printJson(inspection);
        return;
      }
      console.log(`Prisma ${inspection.provider} datasource: ${inspection.datasource}`);
      console.log(`Schema: ${inspection.schemaPath}`);
      console.log(`Connection variable: ${inspection.urlEnvironmentVariable ?? "not declared through env(...)"}`);
      console.log(`Overall migration risk: ${inspection.risk}`);
      if (inspection.migrations.length === 0) console.log("No migration files found");
      for (const migration of inspection.migrations) {
        console.log(`${riskSymbol(migration.risk)} ${migration.name}  ${migration.risk}`);
        for (const finding of migration.findings.filter((item) => item.risk !== "safe")) {
          console.log(`  ${finding.code}: ${finding.message}`);
        }
      }
      if (inspection.diagnostics.length > 0) printDiagnostics(inspection.diagnostics, false);
      process.exitCode = inspection.risk === "destructive" ? 2 : 0;
    } catch (error) {
      printDatabaseError(error, options.json ?? false);
    }
  });

database
  .command("check")
  .description("Run read-only Prisma validation, migration status, or drift checks")
  .argument("<check>", "validate, status, or drift")
  .option("-s, --schema <path>", "Prisma schema path", "prisma/schema.prisma")
  .option("--json", "print machine-readable JSON")
  .action(async (check: string, options: { schema: string; json?: boolean }) => {
    try {
      if (check !== "validate" && check !== "status" && check !== "drift") {
        throw new Error(`Unknown database check ${JSON.stringify(check)}; expected validate, status, or drift`);
      }
      const inspection = await inspectPrismaDatabase(process.cwd(), options.schema);
      if (inspection.provider === "mongodb" && check !== "validate") {
        throw new Error("Prisma migration status and drift checks do not support MongoDB");
      }
      const result = await runPrismaLiveCheck(process.cwd(), inspection.schemaPath, check);
      if (options.json) printJson(result);
      else {
        console.log(`${result.status === "in-sync" ? "✓" : "!"} Prisma ${check}: ${result.status}`);
        if (result.output) console.log(result.output);
      }
      process.exitCode = result.exitCode;
    } catch (error) {
      printDatabaseError(error, options.json ?? false);
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

function riskSymbol(risk: string): string {
  if (risk === "safe") return "✓";
  if (risk === "destructive") return "✗";
  return "!";
}

function supportSymbol(support: string): string {
  return support === "implemented" ? "✓" : "○";
}

function printDatabaseError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  printDiagnostics([{
    code: "database.inspection_failed",
    severity: "error",
    component: "database",
    message,
  }], json);
  process.exitCode = 1;
}
