#!/usr/bin/env node
import { resolve } from "node:path";
import { Command } from "commander";
import { stringify } from "yaml";
import { loadManifest, ManifestValidationError } from "@vibecore/config";
import type { Diagnostic } from "@vibecore/contracts";
import { diagnoseProject, hasDiagnosticErrors } from "@vibecore/diagnostics";
import { createManifestProposal, listLanguageAdapters, scanRepository } from "@vibecore/discovery";
import { applyAdoptionPlan } from "@vibecore/executor";
import { createAdoptionPlan } from "@vibecore/planner";
import { FileStateStore } from "@vibecore/state";
import { applyGitHubEnvironmentPlan, applyGitHubSecretSyncPlan, applyGitHubSetupPlan, auditGitHubEnvironments, createGitHubEnvironmentPlan, createGitHubSecretSyncPlan, createGitHubSetupPlan } from "@vibecore/github";
import { startDevSession } from "@vibecore/runtime";
import { applyDeploymentConfigurationPlan, createDeploymentConfigurationPlan, createVercelPreviewPlan, evaluateDeploymentCompatibility, getDeploymentProvider, listDeploymentProviders } from "@vibecore/deployment";
import { createOpenApiScaffold, discoverApiRoutes, listApiDocumentationAdapters, validateOpenApiFile, writeOpenApiScaffold } from "@vibecore/api-docs";
import { buildLocalDatabaseCompose, diagnoseDatabaseStack, inspectDrizzleMigrations, inspectMongoMigrations, inspectPrismaDatabase, listDatabaseAdapters, runPrismaLiveCheck } from "@vibecore/database";
import type { DatabaseAdapterKind } from "@vibecore/contracts";

const program = new Command()
  .name("vibe")
  .description("Local-first application orchestration")
  .version("0.0.0");

program
  .command("languages")
  .description("Show supported language, package-tool, and framework adapters")
  .option("--json", "print machine-readable JSON")
  .action((options: { json?: boolean }) => {
    const adapters = listLanguageAdapters();
    if (options.json) printJson({ adapters });
    else for (const adapter of adapters) {
      console.log(`${adapter.displayName} (${adapter.id})`);
      console.log(`  Package tools: ${adapter.packageTools.join(", ")}`);
      console.log(`  Frameworks: ${adapter.frameworks.join(", ")}`);
    }
  });

const api = program.command("api").description("Generate and validate secure API documentation");

api.command("docs")
  .description("Preview or write a deterministic OpenAPI 3.1 scaffold")
  .requiredOption("--application <name>", "API application declared in the manifest")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("-o, --output <path>", "OpenAPI output path", "openapi.yaml")
  .option("--write", "write after exact digest approval")
  .option("--approve <digest>", "approve the exact generated digest")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; manifest: string; output: string; write?: boolean; approve?: string; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const application = manifest.applications[options.application];
      if (!application) throw new Error(`Application is not declared: ${options.application}`);
      const discovery = await discoverApiRoutes(process.cwd(), application);
      const scaffold = createOpenApiScaffold(manifest, options.application, options.output, discovery.routes);
      scaffold.diagnostics.push(...discovery.diagnostics);
      if (options.write) {
        if (!options.approve) {
          if (options.json) printJson(scaffold);
          else console.log(`Review the document, then write it with:\n  vibe api docs --application ${options.application} --output ${options.output} --write --approve ${scaffold.digest}`);
          process.exitCode = 2; return;
        }
        const written = await writeOpenApiScaffold(process.cwd(), scaffold, options.approve);
        if (options.json) printJson({ scaffold, written }); else console.log(`✓ Wrote ${written}`);
        return;
      }
      if (options.json) printJson(scaffold);
      else {
        process.stdout.write(scaffold.source);
        console.log(`# Digest: ${scaffold.digest}`);
        if (scaffold.diagnostics.length) printDiagnostics(scaffold.diagnostics, false);
      }
    } catch (error) { printApiError(error, options.json ?? false); }
  });

api.command("adapters")
  .description("Show framework-specific OpenAPI and Swagger adapters")
  .option("--json", "print machine-readable JSON")
  .action((options: { json?: boolean }) => {
    const adapters = listApiDocumentationAdapters();
    if (options.json) printJson({ adapters });
    else for (const adapter of adapters) console.log(`${adapter.framework.padEnd(16)} ${adapter.strategy} (${adapter.packages.join(", ")})`);
  });

api.command("check")
  .description("Validate OpenAPI quality, security, and source-route coverage")
  .requiredOption("--application <name>", "API application declared in the manifest")
  .requiredOption("--spec <path>", "OpenAPI YAML or JSON file")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; spec: string; manifest: string; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const application = manifest.applications[options.application];
      if (!application) throw new Error(`Application is not declared: ${options.application}`);
      const discovery = await discoverApiRoutes(process.cwd(), application);
      const diagnostics = [...await validateOpenApiFile(process.cwd(), options.spec, discovery.routes), ...discovery.diagnostics];
      printDiagnostics(diagnostics, options.json ?? false);
      process.exitCode = hasDiagnosticErrors(diagnostics) ? 1 : 0;
    } catch (error) { printApiError(error, options.json ?? false); }
  });

program
  .command("doctor")
  .description("Run read-only project diagnostics")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("-e, --environment <name>", "environment to validate", "dev")
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
  .option("-e, --environment <name>", "environment to run", "dev")
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

const deploy = program.command("deploy").description("Plan provider deployment configuration");

deploy.command("support")
  .description("Show deployment providers, modes, affordability profiles, and implementation status")
  .option("--provider <provider>", "filter by provider")
  .option("--application <name>", "evaluate an application from the manifest")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { provider?: string; application?: string; manifest: string; json?: boolean }) => {
    try {
      const providers = options.provider ? [getDeploymentProvider(options.provider)].filter((provider) => provider !== undefined) : listDeploymentProviders();
      if (options.provider && providers.length === 0) throw new Error(`Unsupported deployment provider: ${options.provider}`);
      const manifest = options.application ? await loadManifest(resolve(process.cwd(), options.manifest)) : undefined;
      const compatibility = manifest && options.application ? providers.flatMap((provider) => provider.modes.map((mode) => evaluateDeploymentCompatibility(manifest, options.application!, provider.id, mode.id))) : [];
      if (options.json) { printJson({ providers, compatibility }); return; }
      for (const provider of providers) {
        console.log(`${provider.displayName} (${provider.id}) · ${provider.kind} · ${provider.costProfiles.join(", ")}`);
        for (const mode of provider.modes) {
          const match = compatibility.find((candidate) => candidate.provider === provider.id && candidate.mode === mode.id);
          const suffix = match ? ` · ${match.compatible ? `${match.status} for ${match.workload}` : `incompatible: ${match.reasons.join("; ")}`}` : "";
          console.log(`  ${mode.id.padEnd(18)} configure=${mode.configure.padEnd(11)} deploy=${mode.deploy.padEnd(11)} ${mode.workloads.join(", ")}${suffix}`);
        }
      }
    } catch (error) { const message = error instanceof Error ? error.message : String(error); printDiagnostics([{ code: "deployment.support_failed", severity: "error", component: "deployment", message }], options.json ?? false); process.exitCode = 1; }
  });

deploy.command("setup")
  .description("Preview or write provider deployment configuration")
  .requiredOption("--provider <provider>", "deployment provider")
  .option("--mode <mode>", "provider deployment mode")
  .requiredOption("--application <name>", "application declared in the manifest")
  .requiredOption("--revision <sha>", "immutable Git source revision")
  .option("-e, --environment <name>", "target environment", "staging")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--write", "write configuration after exact digest approval")
  .option("--approve <digest>", "approve the exact configuration digest")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { provider: string; mode?: string; application: string; revision: string; environment: string; manifest: string; write?: boolean; approve?: string; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const provider = getDeploymentProvider(options.provider);
      if (!provider) throw new Error(`Unsupported deployment provider: ${options.provider}`);
      const mode = options.mode ?? (provider.id === "vercel" ? "git-web" : provider.modes.length === 1 ? provider.modes[0]?.id : undefined);
      if (!mode) throw new Error(`Select a deployment mode for ${provider.id}: ${provider.modes.map(({ id }) => id).join(", ")}`);
      const plan = provider.id === "vercel" && mode === "git-web" && options.environment === "staging"
        ? createVercelPreviewPlan(manifest, options.application, options.revision)
        : createDeploymentConfigurationPlan(manifest, { provider: provider.id, mode, application: options.application, environment: options.environment, sourceRevision: options.revision });
      if (!options.write) { if (options.json) printJson(plan); else { for (const file of plan.files) console.log(`--- ${file.path}\n${file.content}`); console.log(`Plan digest: ${plan.digest}`); for (const note of plan.notes) console.log(`• ${note}`); } return; }
      if (!options.approve) { if (options.json) printJson(plan); else console.log(`Review the plan, then apply it with:\n  vibe deploy setup --provider ${plan.provider} --mode ${mode} --application ${plan.application} --environment ${plan.environment} --revision ${plan.sourceRevision} --write --approve ${plan.digest}`); process.exitCode = 2; return; }
      const files = await applyDeploymentConfigurationPlan(process.cwd(), plan, options.approve);
      if (options.json) printJson({ plan, files }); else for (const file of files) console.log(`✓ Created ${file}`);
    } catch (error) { const message = error instanceof Error ? error.message : String(error); printDiagnostics([{ code: "deployment.setup_failed", severity: "error", component: "deployment", message }], options.json ?? false); process.exitCode = 1; }
  });

const github = program.command("github").description("Plan secure GitHub repository automation");

github.command("setup")
  .description("Preview or create least-privilege GitHub Actions workflows")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--write", "write generated files after exact digest approval")
  .option("--approve <digest>", "approve the exact generated plan digest")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { manifest: string; write?: boolean; approve?: string; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createGitHubSetupPlan(manifest);
      if (!options.write) {
        if (options.json) printJson(plan);
        else { for (const file of plan.files) console.log(`--- ${file.path}\n${file.content}`); console.log(`Plan digest: ${plan.digest}`); for (const warning of plan.warnings) console.log(`! ${warning}`); }
        return;
      }
      if (!options.approve) { if (options.json) printJson(plan); else console.log(`Review the plan, then apply it with:\n  vibe github setup --write --approve ${plan.digest}`); process.exitCode = 2; return; }
      const files = await applyGitHubSetupPlan(process.cwd(), plan, options.approve);
      if (options.json) printJson({ plan, files }); else for (const file of files) console.log(`✓ Created ${file}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printDiagnostics([{ code: "github.setup_failed", severity: "error", component: "github", message }], options.json ?? false);
      process.exitCode = 1;
    }
  });

github.command("environments")
  .description("Plan or apply dev, staging, and production GitHub environments")
  .requiredOption("--repository <owner/name>", "GitHub repository")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "create or update the remote environments")
  .option("--approve <digest>", "approve the exact remote plan digest")
  .option("--production-approved", "explicitly approve remote production configuration")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { repository: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createGitHubEnvironmentPlan(manifest, options.repository);
      if (!options.apply) {
        if (options.json) printJson(plan);
        else { console.log(`Repository: ${plan.repository}`); for (const environment of plan.environments) console.log(`• ${environment.name} (${environment.secretNames.length} secret name contract(s))`); console.log(`Plan digest: ${plan.digest}`); }
        return;
      }
      if (!options.approve) { if (options.json) printJson(plan); else console.log(`Review the plan, then apply it with:\n  vibe github environments --repository ${plan.repository} --apply --approve ${plan.digest} --production-approved`); process.exitCode = 2; return; }
      const applied = await applyGitHubEnvironmentPlan(plan, options.approve, options.productionApproved ?? false);
      if (options.json) printJson({ plan, applied }); else for (const name of applied) console.log(`✓ Configured GitHub environment ${name}`);
    } catch (error) { const message = error instanceof Error ? error.message : String(error); printDiagnostics([{ code: "github.environments_failed", severity: "error", component: "github", message }], options.json ?? false); process.exitCode = 1; }
  });

github.command("audit")
  .description("Compare remote GitHub environments and secret names with the manifest")
  .requiredOption("--repository <owner/name>", "GitHub repository")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { repository: string; manifest: string; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const audit = await auditGitHubEnvironments(manifest, options.repository);
      if (options.json) printJson(audit); else {
        for (const environment of audit.environments) console.log(`${environment.exists ? "✓" : "✗"} ${environment.name}  ${environment.configuredSecretNames.length}/${environment.requiredSecretNames.length} required secrets configured`);
        printDiagnostics(audit.diagnostics, false);
      }
      process.exitCode = hasDiagnosticErrors(audit.diagnostics) ? 1 : 0;
    } catch (error) { const message = error instanceof Error ? error.message : String(error); printDiagnostics([{ code: "github.audit_failed", severity: "error", component: "github", message }], options.json ?? false); process.exitCode = 1; }
  });

github.command("secrets")
  .description("Plan or synchronize declared secrets to one GitHub environment")
  .requiredOption("--repository <owner/name>", "GitHub repository")
  .requiredOption("--environment <name>", "dev, staging, or production")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "upload values resolved from the current process environment")
  .option("--approve <digest>", "approve the exact secret-name plan digest")
  .option("--production-approved", "explicitly approve production secret synchronization")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { repository: string; environment: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createGitHubSecretSyncPlan(manifest, options.repository, options.environment);
      if (!options.apply) { if (options.json) printJson(plan); else { console.log(`Target: ${plan.repository} / ${plan.environment}`); for (const name of plan.secretNames) console.log(`• ${name}`); console.log(`Plan digest: ${plan.digest}`); } return; }
      if (!options.approve) { if (options.json) printJson(plan); else console.log(`Review the secret-name plan, then apply it with:\n  vibe github secrets --repository ${plan.repository} --environment ${plan.environment} --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`); process.exitCode = 2; return; }
      const applied = await applyGitHubSecretSyncPlan(plan, options.approve, process.env, options.productionApproved ?? false);
      if (options.json) printJson({ repository: plan.repository, environment: plan.environment, appliedSecretNames: applied }); else for (const name of applied) console.log(`✓ Synchronized ${name} to ${plan.environment}`);
    } catch (error) { const message = error instanceof Error ? error.message : String(error); printDiagnostics([{ code: "github.secrets_failed", severity: "error", component: "github", message }], options.json ?? false); process.exitCode = 1; }
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
  .command("compose")
  .description("Preview the secure local Compose model generated from database resources")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { manifest: string; json?: boolean }) => {
    const manifestPath = resolve(process.cwd(), options.manifest);
    try {
      const manifest = await loadManifest(manifestPath);
      const result = buildLocalDatabaseCompose(manifest);
      if (options.json) printJson(result);
      else {
        process.stdout.write(result.yaml);
        if (result.requiredVariables.length > 0) {
          console.log(`# Required environment variables: ${result.requiredVariables.join(", ")}`);
        }
        if (result.diagnostics.length > 0) printDiagnostics(result.diagnostics, false);
      }
      process.exitCode = hasDiagnosticErrors(result.diagnostics) ? 1 : 0;
    } catch (error) {
      printDatabaseError(error, options.json ?? false);
    }
  });

database
  .command("inspect-tool")
  .description("Inspect Drizzle SQL or declarative MongoDB migrations offline")
  .requiredOption("--tool <tool>", "drizzle or mongodb")
  .option("--path <path>", "migration directory")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { tool: string; path?: string; json?: boolean }) => {
    try {
      const result = options.tool === "drizzle"
        ? await inspectDrizzleMigrations(process.cwd(), options.path ?? "drizzle")
        : options.tool === "mongodb"
          ? await inspectMongoMigrations(process.cwd(), options.path ?? "migrations/mongodb")
          : (() => { throw new Error(`Unknown tooling adapter ${JSON.stringify(options.tool)}; expected drizzle or mongodb`); })();
      if (options.json) printJson(result);
      else {
        console.log(`${result.tool} migrations: ${result.migrations.length}; overall risk: ${result.risk}`);
        for (const migration of result.migrations) console.log(`${riskSymbol(migration.risk)} ${migration.name}  ${migration.risk}`);
        if (result.diagnostics.length) printDiagnostics(result.diagnostics, false);
      }
      process.exitCode = result.risk === "destructive" ? 2 : 0;
    } catch (error) { printDatabaseError(error, options.json ?? false); }
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

function printApiError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  printDiagnostics([{ code: "api.documentation_failed", severity: "error", component: "api-docs", message }], json);
  process.exitCode = 1;
}
