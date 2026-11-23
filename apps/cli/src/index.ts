#!/usr/bin/env node
import { basename, resolve } from "node:path";
import { Command } from "commander";
import { stringify } from "yaml";
import { loadManifest, ManifestValidationError } from "@vibecore/config";
import type { DatabaseAdapterKind, DatabaseOperationPlan, DeploymentAttempt, Diagnostic } from "@vibecore/contracts";
import { diagnoseProject, hasDiagnosticErrors } from "@vibecore/diagnostics";
import { createBlueprintManifest, createManifestProposal, inspectExpoProject, listBlueprints, listLanguageAdapters, scanRepository } from "@vibecore/discovery";
import { applyAdoptionPlan } from "@vibecore/executor";
import { createAdoptionPlan } from "@vibecore/planner";
import { FileStateStore } from "@vibecore/state";
import { applyGitHubEnvironmentPlan, applyGitHubSecretSyncPlan, applyGitHubSetupPlan, auditGitHubEnvironments, createGitHubEnvironmentPlan, createGitHubSecretSyncPlan, createGitHubSetupPlan } from "@vibecore/github";
import { startDevSession } from "@vibecore/runtime";
import { applyDeploymentConfigurationPlan, applyHealthResult, applyReconciliationWithHealth, applyVercelLinkPlan, createAwsDeploymentPlan, createAzureDeploymentPlan, createDeploymentConfigurationPlan, createDigitalOceanDeploymentPlan, createDigitalOceanDropletPlan, createDigitalOceanImagePlan, createExpoBuildPlan, createExpoSubmitPlan, createExpoUpdatePlan, createRailwayDeploymentPlan, createReconciliationPlan, createRollbackPlan, createSelfHostedDockerPlan, createSharedHostingPlan, createVercelDeploymentPlan, createVercelLinkPlan, createVercelPreviewPlan, evaluateDeploymentCompatibility, executeAwsDeploymentPlan, executeAwsRollback, executeAzureDeploymentPlan, executeAzureRollback, executeDigitalOceanDeploymentPlan, executeDigitalOceanDropletPlan, executeDigitalOceanDropletRollback, executeDigitalOceanImagePlan, executeDigitalOceanRollback, executeExpoEasPlan, executeRailwayDeploymentPlan, executeSelfHostedDockerPlan, executeSelfHostedRollback, executeSharedHostingPlan, executeSharedHostingRollback, executeVercelDeploymentPlan, executeVercelRollback, getDeploymentProvider, listDeploymentProviders, verifyDeploymentHealth, type AwsDeploymentMode, type AzureDeploymentMode, type ExpoEasPlan, type SharedHostingMode } from "@vibecore/deployment";
import { createOpenApiScaffold, discoverApiRoutes, listApiDocumentationAdapters, validateOpenApiFile, writeOpenApiScaffold } from "@vibecore/api-docs";
import { buildLocalDatabaseCompose, createDatabaseBackupPlan, createDatabaseMigratePlan, createDatabaseRestorePlan, createDatabaseSeedPlan, createNeonBranchPlan, diagnoseDatabaseStack, executeDatabaseOperationPlan, executeNeonBranchPlan, inspectDrizzleMigrations, inspectHostedDatabase, inspectMikroOrmMigrations, inspectMongoMigrations, inspectMongooseMigrations, inspectPrismaDatabase, inspectTypeOrmMigrations, listDatabaseAdapters, runPrismaLiveCheck } from "@vibecore/database";

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

const expo = program.command("expo").description("Inspect Expo/EAS configuration without running a native build");

expo
  .command("inspect")
  .description("Inspect EAS profiles, update channels, and Expo public environment contracts")
  .option("--path <path>", "Expo application path", "apps/mobile")
  .option("-a, --application <name>", "application declared in the manifest")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { path: string; application?: string; manifest: string; json?: boolean }) => {
    try {
      let applicationPath = options.path;
      if (options.application) {
        const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
        const application = manifest.applications[options.application];
        if (!application) throw new Error(`Application is not declared: ${options.application}`);
        if (application.framework !== "expo" && application.type !== "mobile") throw new Error(`${options.application} is not an Expo application`);
        applicationPath = application.path;
      }
      const inspection = await inspectExpoProject(process.cwd(), applicationPath);
      if (options.json) printJson(inspection);
      else {
        console.log(`Expo path: ${inspection.applicationPath}`);
        if (inspection.easPath) console.log(`EAS config: ${inspection.easPath}`);
        for (const profile of inspection.profiles) console.log(`${profile.name}${profile.channel ? ` channel=${profile.channel}` : ""}${profile.distribution ? ` distribution=${profile.distribution}` : ""}`);
        if (inspection.publicVariableNames.length) console.log(`Public variables: ${inspection.publicVariableNames.join(", ")}`);
        if (inspection.diagnostics.length) printDiagnostics(inspection.diagnostics, false);
        if (!inspection.profiles.length && !inspection.diagnostics.length) console.log("No EAS profiles were found");
      }
      process.exitCode = inspection.diagnostics.some(({ severity }) => severity === "error") ? 1 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printDiagnostics([{ code: "expo.inspect_failed", severity: "error", component: "expo", message }], options.json ?? false);
      process.exitCode = 1;
    }
  });

expo
  .command("build")
  .description("Plan or start a non-interactive EAS build without waiting for native output")
  .requiredOption("--application <name>", "Expo application declared in the manifest")
  .requiredOption("--revision <sha>", "immutable Git source revision matching HEAD")
  .option("--profile <name>", "EAS build profile", "production")
  .option("--platform <platform>", "ios, android, or all", "all")
  .option("-e, --environment <name>", "target environment", "staging")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "execute the exact-approved plan with EXPO_TOKEN")
  .option("--approve <digest>", "approve the exact EAS build plan")
  .option("--production-approved", "separately approve a production build")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; profile: string; platform: string; environment: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      if (options.platform !== "ios" && options.platform !== "android" && options.platform !== "all") throw new Error("EAS platform must be ios, android, or all");
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createExpoBuildPlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, profile: options.profile, platform: options.platform });
      await runExpoPlan(plan, options);
    } catch (error) {
      printDiagnostics([{ code: "expo.build_failed", severity: "error", component: "expo", message: error instanceof Error ? error.message : String(error) }], options.json ?? false);
      process.exitCode = 1;
    }
  });

expo
  .command("submit")
  .description("Plan or submit the latest EAS build to the App Store or Play Store")
  .requiredOption("--application <name>", "Expo application declared in the manifest")
  .requiredOption("--revision <sha>", "immutable Git source revision matching HEAD")
  .requiredOption("--platform <platform>", "ios or android")
  .option("--profile <name>", "EAS submit profile", "production")
  .option("-e, --environment <name>", "target environment", "production")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "execute the exact-approved plan with EXPO_TOKEN")
  .option("--approve <digest>", "approve the exact EAS submit plan")
  .option("--production-approved", "separately approve a production submit")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; platform: string; profile: string; environment: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      if (options.platform !== "ios" && options.platform !== "android") throw new Error("EAS submit requires ios or android");
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createExpoSubmitPlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, profile: options.profile, platform: options.platform });
      await runExpoPlan(plan, options);
    } catch (error) {
      printDiagnostics([{ code: "expo.submit_failed", severity: "error", component: "expo", message: error instanceof Error ? error.message : String(error) }], options.json ?? false);
      process.exitCode = 1;
    }
  });

expo
  .command("update")
  .description("Plan or publish an exact-approved EAS update to a channel")
  .requiredOption("--application <name>", "Expo application declared in the manifest")
  .requiredOption("--revision <sha>", "immutable Git source revision matching HEAD")
  .option("--channel <name>", "EAS update channel", "production")
  .option("-e, --environment <name>", "target environment", "staging")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "execute the exact-approved plan with EXPO_TOKEN")
  .option("--approve <digest>", "approve the exact EAS update plan")
  .option("--production-approved", "separately approve a production update")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; channel: string; environment: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createExpoUpdatePlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, channel: options.channel });
      await runExpoPlan(plan, options);
    } catch (error) {
      printDiagnostics([{ code: "expo.update_failed", severity: "error", component: "expo", message: error instanceof Error ? error.message : String(error) }], options.json ?? false);
      process.exitCode = 1;
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
  .command("init")
  .description("Create a manifest from a supported blueprint without generating application source")
  .option("--blueprint <id>", "blueprint identifier", "reference")
  .option("--list", "show available blueprints")
  .option("--json", "print machine-readable JSON")
  .option("--write", "create the manifest after digest approval")
  .option("--approve <digest>", "approve the exact generated plan digest")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .action(async (options: { blueprint: string; list?: boolean; json?: boolean; write?: boolean; approve?: string; manifest: string }) => {
    try {
      if (options.list) {
        const blueprints = listBlueprints();
        if (options.json) printJson({ blueprints });
        else for (const blueprint of blueprints) console.log(`${blueprint.id}\n  ${blueprint.displayName}\n  ${blueprint.description}`);
        return;
      }
      const scan = await scanRepository(process.cwd());
      if (scan.applications.length > 0) throw new Error("This repository already has detectable applications; use vibe adopt instead of vibe init");
      const manifest = createBlueprintManifest(options.blueprint, basename(process.cwd()));
      const plan = createAdoptionPlan(scan, manifest, options.manifest);
      const proposal = { blueprint: options.blueprint, scan, manifest, plan };
      if (!options.json) {
        console.log("# Blueprint manifest proposal. No application source was generated.\n");
        process.stdout.write(stringify(manifest, { lineWidth: 100 }));
        console.log(`\n# Plan: ${plan.id}`);
        console.log(`# Digest: ${plan.digest}`);
      }
      if (options.write) {
        if (!options.approve) {
          if (options.json) printJson(proposal);
          else console.log(`\nReview the plan, then apply it with:\n  vibe init --blueprint ${options.blueprint} --write --approve ${plan.digest}`);
          process.exitCode = 2;
          return;
        }
        const currentScan = await scanRepository(process.cwd());
        const result = await applyAdoptionPlan(plan, { repositoryRoot: process.cwd(), approval: options.approve, currentRepositoryFingerprint: currentScan.fingerprint });
        if (options.json) printJson({ ...proposal, execution: result });
        else console.log(`\n✓ Applied ${result.appliedActions.length} action from ${result.planId}`);
        return;
      }
      if (options.json) printJson(proposal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printDiagnostics([{ code: "init.failed", severity: "error", component: "init", message }], options.json ?? false);
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
      if (state.plans.length === 0 && state.releases.length === 0 && !state.deploymentAttempts?.length) {
        console.log("No local executions have been recorded");
        return;
      }
      for (const plan of state.plans) {
        console.log(`${statusSymbol(plan.status)} ${plan.id}  ${plan.status}  ${plan.environment}  ${plan.updatedAt}`);
      }
      for (const release of state.releases) {
        console.log(`${statusSymbol(release.status)} ${release.id}  ${release.application}  ${release.provider}/${release.mode}  ${release.status}`);
      }
      for (const attempt of state.deploymentAttempts ?? []) {
        console.log(`${attempt.id}  ${attempt.command}  ${attempt.status}  remote outcome unverified  ${attempt.updatedAt}`);
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
  .command("reconcile")
  .description("Plan or apply reconciliation of interrupted plans and deploying releases")
  .option("--apply", "apply the exact-approved reconciliation plan")
  .option("--approve <digest>", "approve the exact reconciliation digest")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { apply?: boolean; approve?: string; json?: boolean }) => {
    try {
      const store = new FileStateStore(process.cwd());
      const state = await store.read();
      const plan = createReconciliationPlan(state);
      if (!options.apply) {
        if (options.json) printJson({ plan });
        else {
          if (plan.planIds.length) console.log(`Interrupted plans: ${plan.planIds.join(", ")}`);
          if (plan.releaseIds.length) console.log(`Deploying releases: ${plan.releaseIds.join(", ")}`);
          console.log(`Plan digest: ${plan.digest}`);
          console.log("No ledger entries were changed.");
        }
        return;
      }
      if (!options.approve) {
        if (options.json) printJson({ plan });
        else console.log(`Review the plan, then apply it with:\n  vibe reconcile --apply --approve ${plan.digest}`);
        process.exitCode = 2;
        return;
      }
      const next = await applyReconciliationWithHealth(state, plan, options.approve);
      const selected = (value: typeof state | typeof next) => ({
        plans: value.plans.filter((entry) => plan.planIds.includes(entry.id)),
        releases: value.releases.filter((release) => plan.releaseIds.includes(release.id)),
      });
      await store.compareAndSwapRecords(selected(state), selected(next));
      if (options.json) printJson({ plan, plans: next.plans.filter((entry) => plan.planIds.includes(entry.id)), releases: next.releases.filter((release) => plan.releaseIds.includes(release.id)) });
      else console.log(`✓ Reconciled ${plan.planIds.length} plan(s) and ${plan.releaseIds.length} release(s)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      printDiagnostics([{ code: "state.reconcile_failed", severity: "error", component: "state", message }], options.json ?? false);
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

deploy.command("releases")
  .description("Show the local, secret-free deployment release ledger")
  .option("--application <name>", "filter by application")
  .option("-e, --environment <name>", "filter by environment")
  .option("--provider <provider>", "filter by provider")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application?: string; environment?: string; provider?: string; json?: boolean }) => {
    try {
      const releases = await new FileStateStore(process.cwd()).releases({ ...(options.application ? { application: options.application } : {}), ...(options.environment ? { environment: options.environment } : {}), ...(options.provider ? { provider: options.provider } : {}) });
      if (options.json) { printJson({ releases }); return; }
      if (!releases.length) { console.log("No deployment releases have been recorded"); return; }
      for (const release of releases) console.log(`${statusSymbol(release.status)} ${release.id}  ${release.application}  ${release.provider}/${release.mode}  ${release.environment}  ${release.sourceRevision}  ${release.status}`);
    } catch (error) { printDeploymentError("deployment.releases_failed", error, options.json ?? false); }
  });

deploy.command("verify-health")
  .description("Verify and record health for a deploying release")
  .requiredOption("--release <id>", "release ledger identifier")
  .requiredOption("--url <url>", "HTTP or HTTPS health URL without credentials")
  .option("--attempts <count>", "health attempts", "3")
  .option("--timeout <seconds>", "timeout per attempt", "30")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { release: string; url: string; attempts: string; timeout: string; json?: boolean }) => {
    try {
      const store = new FileStateStore(process.cwd());
      const release = (await store.releases()).find(({ id }) => id === options.release);
      if (!release) throw new Error(`Unknown release: ${options.release}`);
      if (release.status !== "deploying") throw new Error("Health verification requires a deploying release; completed or rolled-back releases cannot be reopened");
      const health = await verifyDeploymentHealth(options.url, { attempts: parseInteger(options.attempts, "attempts"), timeoutSeconds: parseInteger(options.timeout, "timeout") });
      const updated = applyHealthResult(release, health);
      await store.updateRelease(updated, release);
      if (options.json) printJson({ release: updated }); else console.log(`${health.status === "healthy" ? "✓" : "✗"} ${release.id} is ${health.status} after ${health.attempts} attempt(s)`);
      process.exitCode = health.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.health_failed", error, options.json ?? false); }
  });

deploy.command("rollback")
  .description("Plan rollback to the preceding healthy immutable release")
  .requiredOption("--release <id>", "unhealthy or failed release identifier")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { release: string; json?: boolean }) => {
    try {
      const plan = createRollbackPlan(await new FileStateStore(process.cwd()).releases(), options.release);
      if (options.json) printJson({ plan }); else { console.log(`Rollback ${plan.failedReleaseId} to ${plan.targetReleaseId} (${plan.targetSourceRevision})`); console.log(`Strategy: ${plan.strategy}`); console.log(`Plan digest: ${plan.digest}`); console.log("No remote change was made; a provider executor must apply this exact plan."); }
    } catch (error) { printDeploymentError("deployment.rollback_failed", error, options.json ?? false); }
  });

deploy.command("self-hosted")
  .description("Plan or execute a versioned Docker Compose deployment over SSH")
  .requiredOption("--application <name>", "application declared in the manifest")
  .requiredOption("--revision <sha>", "immutable Git source revision")
  .requiredOption("--host <host>", "SSH hostname with a pinned known-host entry")
  .requiredOption("--user <user>", "non-root SSH deployment user")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .option("-e, --environment <name>", "target environment", "staging")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--remote-root <path>", "versioned remote deployment root")
  .option("--ssh-key <path>", "absolute private key path; never stored in the plan")
  .option("--apply", "execute the exact-approved plan over SSH")
  .option("--approve <digest>", "approve the exact deployment plan digest")
  .option("--production-approved", "separately approve a production deployment")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; host: string; user: string; healthUrl: string; environment: string; manifest: string; remoteRoot?: string; sshKey?: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createSelfHostedDockerPlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, host: options.host, user: options.user, healthUrl: options.healthUrl, ...(options.remoteRoot ? { remoteRoot: options.remoteRoot } : {}) });
      if (!options.apply) { if (options.json) printJson({ plan }); else { console.log(plan.compose); console.log(`Remote environment file: ${plan.remoteEnvironmentFile}`); console.log(`Required secret names: ${plan.requiredSecretNames.join(", ") || "none"}`); console.log(`Plan digest: ${plan.digest}`); console.log("No remote command was run."); } return; }
      if (!options.approve || !options.sshKey) { if (options.json) printJson({ plan }); else console.log(`Review the plan, then apply it with:\n  vibe deploy self-hosted --application ${plan.application} --environment ${plan.environment} --revision ${plan.sourceRevision} --host ${plan.host} --user ${plan.user} --health-url ${plan.healthUrl} --ssh-key /absolute/path --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`); process.exitCode = 2; return; }
      const result = await executeSelfHostedDockerPlan(plan, { approval: options.approve, sshKeyPath: options.sshKey, productionApproved: options.productionApproved ?? false });
      await new FileStateStore(process.cwd()).recordRelease(result.release);
      if (options.json) printJson({ plan, release: result.release }); else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} Recorded ${result.release.id} as ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.self_hosted_failed", error, options.json ?? false); }
  });

deploy.command("self-hosted-rollback")
  .description("Apply an exact-approved rollback using a versioned remote Compose release")
  .requiredOption("--release <id>", "unhealthy or failed release identifier")
  .requiredOption("--host <host>", "SSH hostname with a pinned known-host entry")
  .requiredOption("--user <user>", "non-root SSH deployment user")
  .requiredOption("--remote-root <path>", "versioned remote deployment root")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .requiredOption("--ssh-key <path>", "absolute private key path; never stored in the plan")
  .requiredOption("--approve <digest>", "approve the exact rollback plan digest")
  .option("--production-approved", "separately approve a production rollback")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { release: string; host: string; user: string; remoteRoot: string; healthUrl: string; sshKey: string; approve: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const store = new FileStateStore(process.cwd()); const releases = await store.releases(); const plan = createRollbackPlan(releases, options.release);
      const result = await executeSelfHostedRollback(plan, releases, { approval: options.approve, host: options.host, user: options.user, remoteRoot: options.remoteRoot, healthUrl: options.healthUrl, sshKeyPath: options.sshKey, productionApproved: options.productionApproved ?? false });
      await store.commitRollback(releases.filter(({ id }) => id === plan.failedReleaseId || id === plan.targetReleaseId), result.failed, result.release);
      if (options.json) printJson({ plan, release: result.release }); else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} Rollback release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.self_hosted_rollback_failed", error, options.json ?? false); }
  });

deploy.command("railway")
  .description("Plan or execute a Railway deployment from the approved repository revision")
  .requiredOption("--application <name>", "application declared in the manifest")
  .requiredOption("--revision <sha>", "immutable Git source revision matching HEAD")
  .requiredOption("--project <id>", "existing Railway project ID or name")
  .requiredOption("--service <id>", "existing Railway service ID or name")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .option("--mode <mode>", "git or dockerfile", "git")
  .option("-e, --environment <name>", "Vibecore target environment", "staging")
  .option("--railway-environment <id>", "Railway environment ID or name")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "execute the exact-approved plan with RAILWAY_TOKEN")
  .option("--approve <digest>", "approve the exact Railway deployment plan")
  .option("--production-approved", "separately approve a production deployment")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; project: string; service: string; healthUrl: string; mode: string; environment: string; railwayEnvironment?: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      if (options.mode !== "git" && options.mode !== "dockerfile") throw new Error("Railway mode must be git or dockerfile");
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createRailwayDeploymentPlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, mode: options.mode, project: options.project, service: options.service, healthUrl: options.healthUrl, ...(options.railwayEnvironment ? { railwayEnvironment: options.railwayEnvironment } : {}) });
      if (!options.apply) { if (options.json) printJson({ plan }); else { console.log(`Target: ${plan.project}/${plan.service} (${plan.railwayEnvironment})`); console.log(`Source: ${plan.sourceRevision} from ${plan.applicationPath}`); console.log(`Required secret names: ${plan.requiredSecretNames.join(", ")}`); console.log(`Plan digest: ${plan.digest}`); console.log("No Railway deployment was started."); } return; }
      const token = process.env.RAILWAY_TOKEN;
      if (!options.approve || !token) { if (options.json) printJson({ plan }); else console.log(`Set RAILWAY_TOKEN in the current process, then apply with:\n  vibe deploy railway --application ${plan.application} --environment ${plan.environment} --revision ${plan.sourceRevision} --project ${plan.project} --service ${plan.service} --health-url ${plan.healthUrl} --mode ${plan.mode} --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`); process.exitCode = 2; return; }
      const result = await executeRailwayDeploymentPlan(plan, { approval: options.approve, repositoryRoot: process.cwd(), token, productionApproved: options.productionApproved ?? false });
      await new FileStateStore(process.cwd()).recordRelease(result.release);
      if (options.json) printJson({ plan, release: result.release }); else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} Railway release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.railway_failed", error, options.json ?? false); }
  });

deploy.command("vercel")
  .description("Plan or deploy an approved revision to an existing Vercel project")
  .requiredOption("--application <name>", "application declared in the manifest")
  .requiredOption("--revision <sha>", "immutable Git source revision matching HEAD")
  .requiredOption("--org <id>", "existing Vercel org or team ID")
  .requiredOption("--project <id>", "existing Vercel project ID")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .option("-e, --environment <name>", "target environment", "staging")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "execute the exact-approved plan with VERCEL_TOKEN")
  .option("--approve <digest>", "approve the exact Vercel deployment plan")
  .option("--production-approved", "separately approve a production deployment")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; org: string; project: string; healthUrl: string; environment: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createVercelDeploymentPlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, orgId: options.org, projectId: options.project, healthUrl: options.healthUrl });
      if (!options.apply) {
        if (options.json) printJson({ plan });
        else {
          console.log(`Target: Vercel ${plan.orgId}/${plan.projectId} (${plan.production ? "production" : "preview"})`);
          console.log(`Source: ${plan.sourceRevision} from ${plan.applicationPath}`);
          console.log(`Required secret names: ${plan.requiredSecretNames.join(", ")}`);
          console.log(`Plan digest: ${plan.digest}`);
          console.log("No Vercel deployment was started.");
        }
        return;
      }
      const token = process.env.VERCEL_TOKEN;
      if (!options.approve || !token) {
        if (options.json) printJson({ plan });
        else console.log(`Set VERCEL_TOKEN in the current process, then apply with:\n  vibe deploy vercel --application ${plan.application} --environment ${plan.environment} --revision ${plan.sourceRevision} --org ${plan.orgId} --project ${plan.projectId} --health-url ${plan.healthUrl} --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`);
        process.exitCode = 2;
        return;
      }
      const result = await executeVercelDeploymentPlan(plan, { approval: options.approve, repositoryRoot: process.cwd(), token, productionApproved: options.productionApproved ?? false });
      await new FileStateStore(process.cwd()).recordRelease(result.release);
      if (options.json) printJson({ plan, release: result.release });
      else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} Vercel release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.vercel_failed", error, options.json ?? false); }
  });

deploy.command("vercel-rollback")
  .description("Apply an exact-approved Vercel production rollback to a preceding deployment ID")
  .requiredOption("--release <id>", "unhealthy or failed release identifier")
  .requiredOption("--org <id>", "existing Vercel org or team ID")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .requiredOption("--approve <digest>", "approve the exact rollback plan digest")
  .option("--production-approved", "separately approve a production rollback")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { release: string; org: string; healthUrl: string; approve: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const token = process.env.VERCEL_TOKEN;
      if (!token) throw new Error("Set VERCEL_TOKEN in the current process");
      const store = new FileStateStore(process.cwd());
      const releases = await store.releases();
      const plan = createRollbackPlan(releases, options.release);
      const result = await executeVercelRollback(plan, releases, { approval: options.approve, token, orgId: options.org, healthUrl: options.healthUrl, productionApproved: options.productionApproved ?? false });
      await store.commitRollback(releases.filter(({ id }) => id === plan.failedReleaseId || id === plan.targetReleaseId), result.failed, result.release);
      if (options.json) printJson({ plan, release: result.release });
      else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} Vercel rollback release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.vercel_rollback_failed", error, options.json ?? false); }
  });

deploy.command("vercel-link")
  .description("Plan or write a local Vercel project link for an existing org and project")
  .requiredOption("--application <name>", "application declared in the manifest")
  .requiredOption("--org <id>", "existing Vercel org or team ID")
  .requiredOption("--project <id>", "existing Vercel project ID")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "write .vercel/project.json after verifying the project")
  .option("--approve <digest>", "approve the exact link plan digest")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; org: string; project: string; manifest: string; apply?: boolean; approve?: string; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createVercelLinkPlan(manifest, { application: options.application, orgId: options.org, projectId: options.project });
      if (!options.apply) {
        if (options.json) printJson({ plan });
        else {
          console.log(`Link ${plan.applicationPath} to ${plan.orgId}/${plan.projectId}`);
          console.log(`File: ${plan.filePath}`);
          console.log(`Plan digest: ${plan.digest}`);
          console.log("No file was written.");
        }
        return;
      }
      const token = process.env.VERCEL_TOKEN;
      if (!options.approve || !token) {
        if (options.json) printJson({ plan });
        else console.log(`Set VERCEL_TOKEN, then apply with --apply --approve ${plan.digest}`);
        process.exitCode = 2;
        return;
      }
      const written = await applyVercelLinkPlan(plan, { approval: options.approve, repositoryRoot: process.cwd(), token });
      if (options.json) printJson({ plan, written });
      else console.log(`✓ Wrote ${written}`);
    } catch (error) { printDeploymentError("deployment.vercel_link_failed", error, options.json ?? false); }
  });

deploy.command("digitalocean")
  .description("Plan or deploy an approved revision to an existing DigitalOcean App Platform app")
  .requiredOption("--application <name>", "application declared in the manifest")
  .requiredOption("--revision <sha>", "full Git source revision matching HEAD and the remote branch")
  .requiredOption("--app-id <id>", "existing DigitalOcean App Platform app ID")
  .requiredOption("--repository <owner/name>", "GitHub repository configured on the app")
  .requiredOption("--branch <branch>", "GitHub branch configured on the app")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .option("--git-remote <name>", "local Git remote used to verify the branch", "origin")
  .option("-e, --environment <name>", "Vibecore target environment", "staging")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "start the exact-approved deployment")
  .option("--approve <digest>", "approve the exact DigitalOcean deployment plan")
  .option("--production-approved", "separately approve a production deployment")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; appId: string; repository: string; branch: string; healthUrl: string; gitRemote: string; environment: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest)); const plan = createDigitalOceanDeploymentPlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, appId: options.appId, repository: options.repository, branch: options.branch, gitRemote: options.gitRemote, healthUrl: options.healthUrl });
      if (!options.apply) { if (options.json) printJson({ plan }); else { console.log(`Target: DigitalOcean app ${plan.appId}`); console.log(`Source: ${plan.repository}@${plan.branch} (${plan.sourceRevision})`); console.log(`Required secret names: ${plan.requiredSecretNames.join(", ")}`); console.log(`Plan digest: ${plan.digest}`); console.log("No DigitalOcean deployment was started."); } return; }
      const token = process.env.DIGITALOCEAN_ACCESS_TOKEN;
      if (!options.approve || !token) { if (options.json) printJson({ plan }); else console.log(`Set DIGITALOCEAN_ACCESS_TOKEN in the current process, then repeat this command with --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`); process.exitCode = 2; return; }
      const result = await executeDigitalOceanDeploymentPlan(plan, { approval: options.approve, repositoryRoot: process.cwd(), token, productionApproved: options.productionApproved ?? false }); await new FileStateStore(process.cwd()).recordRelease(result.release);
      if (options.json) printJson({ plan, release: result.release }); else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} DigitalOcean release ${result.release.id} is ${result.release.status}`); process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.digitalocean_failed", error, options.json ?? false); }
  });

deploy.command("digitalocean-image")
  .description("Plan or deploy a digest-pinned image to an existing DigitalOcean App Platform app")
  .requiredOption("--application <name>", "application declared in the manifest")
  .requiredOption("--revision <sha>", "immutable Git source revision matching HEAD")
  .requiredOption("--app-id <id>", "existing DigitalOcean App Platform app ID")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .option("-e, --environment <name>", "Vibecore target environment", "staging")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "start the exact-approved deployment")
  .option("--approve <digest>", "approve the exact DigitalOcean image plan")
  .option("--production-approved", "separately approve a production deployment")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; appId: string; healthUrl: string; environment: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createDigitalOceanImagePlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, appId: options.appId, healthUrl: options.healthUrl });
      if (!options.apply) {
        if (options.json) printJson({ plan });
        else {
          console.log(`Target: DigitalOcean app ${plan.appId}`);
          console.log(`Image: ${plan.image}`);
          console.log(`Required secret names: ${plan.requiredSecretNames.join(", ")}`);
          console.log(`Plan digest: ${plan.digest}`);
          console.log("No DigitalOcean deployment was started.");
        }
        return;
      }
      const token = process.env.DIGITALOCEAN_ACCESS_TOKEN;
      if (!options.approve || !token) {
        if (options.json) printJson({ plan });
        else console.log(`Set DIGITALOCEAN_ACCESS_TOKEN in the current process, then repeat this command with --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`);
        process.exitCode = 2;
        return;
      }
      const result = await executeDigitalOceanImagePlan(plan, { approval: options.approve, repositoryRoot: process.cwd(), token, productionApproved: options.productionApproved ?? false });
      await new FileStateStore(process.cwd()).recordRelease(result.release);
      if (options.json) printJson({ plan, release: result.release });
      else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} DigitalOcean image release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.digitalocean_image_failed", error, options.json ?? false); }
  });

deploy.command("digitalocean-rollback")
  .description("Apply an exact-approved DigitalOcean historical deployment rollback")
  .requiredOption("--release <id>", "unhealthy or failed release identifier")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .requiredOption("--approve <digest>", "approve the exact rollback plan digest")
  .option("--production-approved", "separately approve a production rollback")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { release: string; healthUrl: string; approve: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const token = process.env.DIGITALOCEAN_ACCESS_TOKEN; if (!token) throw new Error("Set DIGITALOCEAN_ACCESS_TOKEN in the current process"); const store = new FileStateStore(process.cwd()); const releases = await store.releases(); const plan = createRollbackPlan(releases, options.release); const result = await executeDigitalOceanRollback(plan, releases, { approval: options.approve, token, healthUrl: options.healthUrl, productionApproved: options.productionApproved ?? false }); await store.commitRollback(releases.filter(({ id }) => id === plan.failedReleaseId || id === plan.targetReleaseId), result.failed, result.release);
      if (options.json) printJson({ plan, release: result.release }); else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} DigitalOcean rollback release ${result.release.id} is ${result.release.status}`); process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.digitalocean_rollback_failed", error, options.json ?? false); }
  });

deploy.command("digitalocean-droplet")
  .description("Plan or execute a versioned Docker Compose deployment on an existing DigitalOcean Droplet")
  .requiredOption("--application <name>", "application declared in the manifest")
  .requiredOption("--revision <sha>", "immutable Git source revision")
  .requiredOption("--droplet-id <id>", "existing DigitalOcean droplet ID")
  .requiredOption("--host <host>", "droplet name or public address with a pinned known-host entry")
  .requiredOption("--user <user>", "non-root SSH deployment user")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .option("-e, --environment <name>", "target environment", "staging")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--remote-root <path>", "versioned remote deployment root")
  .option("--ssh-key <path>", "absolute private key path; never stored in the plan")
  .option("--apply", "execute the exact-approved plan")
  .option("--approve <digest>", "approve the exact Droplet deployment plan digest")
  .option("--production-approved", "separately approve a production deployment")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; dropletId: string; host: string; user: string; healthUrl: string; environment: string; manifest: string; remoteRoot?: string; sshKey?: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createDigitalOceanDropletPlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, dropletId: options.dropletId, host: options.host, user: options.user, healthUrl: options.healthUrl, ...(options.remoteRoot ? { remoteRoot: options.remoteRoot } : {}) });
      if (!options.apply) {
        if (options.json) printJson({ plan });
        else {
          console.log(plan.compose);
          console.log(`Droplet: ${plan.dropletId} @ ${plan.user}@${plan.host}`);
          console.log(`Remote environment file: ${plan.remoteEnvironmentFile}`);
          console.log(`Required secret names: ${plan.requiredSecretNames.join(", ")}`);
          console.log(`Plan digest: ${plan.digest}`);
          console.log("No DigitalOcean or SSH command was run.");
        }
        return;
      }
      const token = process.env.DIGITALOCEAN_ACCESS_TOKEN;
      if (!options.approve || !token || !options.sshKey) {
        if (options.json) printJson({ plan });
        else console.log(`Set DIGITALOCEAN_ACCESS_TOKEN, then apply with:\n  vibe deploy digitalocean-droplet --application ${plan.application} --environment ${plan.environment} --revision ${plan.sourceRevision} --droplet-id ${plan.dropletId} --host ${plan.host} --user ${plan.user} --health-url ${plan.healthUrl} --ssh-key /absolute/path --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`);
        process.exitCode = 2;
        return;
      }
      const result = await executeDigitalOceanDropletPlan(plan, { approval: options.approve, token, sshKeyPath: options.sshKey, productionApproved: options.productionApproved ?? false });
      await new FileStateStore(process.cwd()).recordRelease(result.release);
      if (options.json) printJson({ plan, release: result.release });
      else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} DigitalOcean Droplet release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.digitalocean_droplet_failed", error, options.json ?? false); }
  });

deploy.command("digitalocean-droplet-rollback")
  .description("Apply an exact-approved Droplet rollback using a versioned remote Compose release")
  .requiredOption("--release <id>", "unhealthy or failed release identifier")
  .requiredOption("--host <host>", "droplet name or public address with a pinned known-host entry")
  .requiredOption("--user <user>", "non-root SSH deployment user")
  .requiredOption("--remote-root <path>", "versioned remote deployment root")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .requiredOption("--ssh-key <path>", "absolute private key path; never stored in the plan")
  .requiredOption("--approve <digest>", "approve the exact rollback plan digest")
  .option("--production-approved", "separately approve a production rollback")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { release: string; host: string; user: string; remoteRoot: string; healthUrl: string; sshKey: string; approve: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const token = process.env.DIGITALOCEAN_ACCESS_TOKEN;
      if (!token) throw new Error("Set DIGITALOCEAN_ACCESS_TOKEN in the current process");
      const store = new FileStateStore(process.cwd());
      const releases = await store.releases();
      const plan = createRollbackPlan(releases, options.release);
      const result = await executeDigitalOceanDropletRollback(plan, releases, { approval: options.approve, token, host: options.host, user: options.user, remoteRoot: options.remoteRoot, healthUrl: options.healthUrl, sshKeyPath: options.sshKey, productionApproved: options.productionApproved ?? false });
      await store.commitRollback(releases.filter(({ id }) => id === plan.failedReleaseId || id === plan.targetReleaseId), result.failed, result.release);
      if (options.json) printJson({ plan, release: result.release });
      else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} DigitalOcean Droplet rollback release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.digitalocean_droplet_rollback_failed", error, options.json ?? false); }
  });

deploy.command("azure")
  .description("Plan or deploy an approved revision to existing Azure App Service, Container Apps, or Static Web Apps")
  .requiredOption("--application <name>", "application declared in the manifest")
  .requiredOption("--revision <sha>", "full Git source revision matching HEAD")
  .requiredOption("--mode <mode>", "static-web-apps, app-service, or container-apps")
  .requiredOption("--subscription <guid>", "Azure subscription ID")
  .requiredOption("--tenant <guid>", "Azure tenant ID")
  .requiredOption("--resource-group <name>", "existing Azure resource group")
  .requiredOption("--name <name>", "existing Azure resource name")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .option("-e, --environment <name>", "Vibecore target environment", "staging")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "execute the exact-approved plan with the current az identity")
  .option("--approve <digest>", "approve the exact Azure deployment plan")
  .option("--production-approved", "separately approve a production deployment")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; mode: string; subscription: string; tenant: string; resourceGroup: string; name: string; healthUrl: string; environment: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      if (options.mode !== "static-web-apps" && options.mode !== "app-service" && options.mode !== "container-apps") throw new Error("Azure mode must be static-web-apps, app-service, or container-apps");
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createAzureDeploymentPlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, mode: options.mode as AzureDeploymentMode, subscriptionId: options.subscription, tenantId: options.tenant, resourceGroup: options.resourceGroup, resourceName: options.name, healthUrl: options.healthUrl });
      if (!options.apply) { if (options.json) printJson({ plan }); else { console.log(`Target: Azure ${plan.mode} ${plan.resourceGroup}/${plan.resourceName}`); console.log(`Subscription: ${plan.subscriptionId}`); console.log(`Source: ${plan.sourceRevision} from ${plan.applicationPath}`); console.log(`Required secret names: ${plan.requiredSecretNames.join(", ") || "none"}`); console.log(`Plan digest: ${plan.digest}`); console.log("No Azure deployment was started."); } return; }
      if (!options.approve) { if (options.json) printJson({ plan }); else console.log(`Review the plan, then apply it with the current az login:\n  vibe deploy azure --application ${plan.application} --environment ${plan.environment} --revision ${plan.sourceRevision} --mode ${plan.mode} --subscription ${plan.subscriptionId} --tenant ${plan.tenantId} --resource-group ${plan.resourceGroup} --name ${plan.resourceName} --health-url ${plan.healthUrl} --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`); process.exitCode = 2; return; }
      const result = await executeAzureDeploymentPlan(plan, { approval: options.approve, repositoryRoot: process.cwd(), productionApproved: options.productionApproved ?? false });
      await new FileStateStore(process.cwd()).recordRelease(result.release);
      if (options.json) printJson({ plan, release: result.release }); else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} Azure release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.azure_failed", error, options.json ?? false); }
  });

deploy.command("azure-rollback")
  .description("Apply an exact-approved Azure App Service or Container Apps rollback")
  .requiredOption("--release <id>", "unhealthy or failed release identifier")
  .requiredOption("--tenant <guid>", "Azure tenant ID matching the current az identity")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .requiredOption("--approve <digest>", "approve the exact rollback plan digest")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--production-approved", "separately approve a production rollback")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { release: string; tenant: string; healthUrl: string; approve: string; manifest: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const store = new FileStateStore(process.cwd());
      const releases = await store.releases();
      const plan = createRollbackPlan(releases, options.release);
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const application = manifest.applications[plan.application];
      if (!application) throw new Error(`Application is not declared: ${plan.application}`);
      const result = await executeAzureRollback(plan, releases, { approval: options.approve, repositoryRoot: process.cwd(), applicationPath: application.path, tenantId: options.tenant, healthUrl: options.healthUrl, productionApproved: options.productionApproved ?? false });
      await store.commitRollback(releases.filter(({ id }) => id === plan.failedReleaseId || id === plan.targetReleaseId), result.failed, result.release);
      if (options.json) printJson({ plan, release: result.release }); else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} Azure rollback release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.azure_rollback_failed", error, options.json ?? false); }
  });

deploy.command("aws")
  .description("Plan or deploy an approved revision to existing AWS S3/CloudFront, App Runner, or ECS Fargate resources")
  .requiredOption("--application <name>", "application declared in the manifest")
  .requiredOption("--revision <sha>", "full Git source revision matching HEAD")
  .requiredOption("--mode <mode>", "s3-cloudfront, app-runner, or ecs-fargate")
  .requiredOption("--account <id>", "12-digit AWS account ID")
  .requiredOption("--region <region>", "AWS region")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .option("--bucket <name>", "existing private versioned S3 bucket")
  .option("--distribution <id>", "existing CloudFront distribution ID")
  .option("--service-arn <arn>", "existing App Runner service ARN")
  .option("--cluster <name>", "existing ECS cluster name")
  .option("--service <name>", "existing ECS service name")
  .option("-e, --environment <name>", "Vibecore target environment", "staging")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--apply", "execute the exact-approved plan with the current AWS CLI identity")
  .option("--approve <digest>", "approve the exact AWS deployment plan")
  .option("--production-approved", "separately approve a production deployment")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; mode: string; account: string; region: string; healthUrl: string; bucket?: string; distribution?: string; serviceArn?: string; cluster?: string; service?: string; environment: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      if (options.mode !== "s3-cloudfront" && options.mode !== "app-runner" && options.mode !== "ecs-fargate") throw new Error("AWS mode must be s3-cloudfront, app-runner, or ecs-fargate");
      if (options.mode === "s3-cloudfront" && (!options.bucket || !options.distribution)) throw new Error("S3 and CloudFront deployment requires --bucket and --distribution");
      if (options.mode === "app-runner" && !options.serviceArn) throw new Error("App Runner deployment requires --service-arn");
      if (options.mode === "ecs-fargate" && (!options.cluster || !options.service)) throw new Error("ECS Fargate deployment requires --cluster and --service");
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createAwsDeploymentPlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, mode: options.mode as AwsDeploymentMode, accountId: options.account, region: options.region, healthUrl: options.healthUrl, ...(options.bucket ? { bucket: options.bucket } : {}), ...(options.distribution ? { distributionId: options.distribution } : {}), ...(options.serviceArn ? { serviceArn: options.serviceArn } : {}), ...(options.cluster ? { cluster: options.cluster } : {}), ...(options.service ? { service: options.service } : {}) });
      if (!options.apply) { if (options.json) printJson({ plan }); else { console.log(`Target: AWS ${plan.mode} ${plan.region}/${plan.accountId}`); console.log(`Source: ${plan.sourceRevision} from ${plan.applicationPath}`); console.log(`Required secret names: ${plan.requiredSecretNames.join(", ") || "none"}`); console.log(`Plan digest: ${plan.digest}`); console.log("No AWS deployment was started."); } return; }
      if (!options.approve) { if (options.json) printJson({ plan }); else console.log(`Review the plan, then apply it with the current AWS CLI identity:\n  vibe deploy aws --application ${plan.application} --environment ${plan.environment} --revision ${plan.sourceRevision} --mode ${plan.mode} --account ${plan.accountId} --region ${plan.region} --health-url ${plan.healthUrl} --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`); process.exitCode = 2; return; }
      const result = await executeAwsDeploymentPlan(plan, { approval: options.approve, repositoryRoot: process.cwd(), productionApproved: options.productionApproved ?? false });
      await new FileStateStore(process.cwd()).recordRelease(result.release);
      if (options.json) printJson({ plan, release: result.release }); else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} AWS release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.aws_failed", error, options.json ?? false); }
  });

deploy.command("aws-rollback")
  .description("Apply an exact-approved AWS S3/CloudFront, App Runner, or ECS Fargate rollback")
  .requiredOption("--release <id>", "unhealthy or failed release identifier")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .requiredOption("--approve <digest>", "approve the exact rollback plan digest")
  .option("--production-approved", "separately approve a production rollback")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { release: string; healthUrl: string; approve: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const store = new FileStateStore(process.cwd());
      const releases = await store.releases();
      const plan = createRollbackPlan(releases, options.release);
      const result = await executeAwsRollback(plan, releases, { approval: options.approve, healthUrl: options.healthUrl, productionApproved: options.productionApproved ?? false });
      await store.commitRollback(releases.filter(({ id }) => id === plan.failedReleaseId || id === plan.targetReleaseId), result.failed, result.release);
      if (options.json) printJson({ plan, release: result.release }); else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} AWS rollback release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.aws_rollback_failed", error, options.json ?? false); }
  });

deploy.command("shared-hosting")
  .description("Plan or upload a versioned static or PHP release over SSH/SFTP")
  .requiredOption("--application <name>", "application declared in the manifest")
  .requiredOption("--revision <sha>", "immutable Git source revision")
  .requiredOption("--mode <mode>", "static-sftp or php-sftp")
  .requiredOption("--host <host>", "SSH hostname with a pinned known-host entry")
  .requiredOption("--user <user>", "non-root SSH deployment user")
  .requiredOption("--remote-root <path>", "versioned remote deployment root")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .option("-e, --environment <name>", "target environment", "staging")
  .option("-m, --manifest <path>", "manifest path", "vibecore.yaml")
  .option("--ssh-key <path>", "absolute private key path; never stored in the plan")
  .option("--apply", "execute the exact-approved plan over SSH")
  .option("--approve <digest>", "approve the exact deployment plan digest")
  .option("--production-approved", "separately approve a production deployment")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { application: string; revision: string; mode: string; host: string; user: string; remoteRoot: string; healthUrl: string; environment: string; manifest: string; sshKey?: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      if (options.mode !== "static-sftp" && options.mode !== "php-sftp") throw new Error("Shared hosting mode must be static-sftp or php-sftp");
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const plan = createSharedHostingPlan(manifest, { application: options.application, environment: options.environment, sourceRevision: options.revision, mode: options.mode as SharedHostingMode, host: options.host, user: options.user, remoteRoot: options.remoteRoot, healthUrl: options.healthUrl });
      if (!options.apply) {
        if (options.json) printJson({ plan });
        else {
          console.log(`Target: ${plan.user}@${plan.host}:${plan.remoteRoot}`);
          console.log(`Source: ${plan.sourceDirectory} @ ${plan.sourceRevision}`);
          console.log(`Required secret names: ${plan.requiredSecretNames.join(", ") || "none"}`);
          console.log(`Plan digest: ${plan.digest}`);
          console.log("No remote command was run.");
        }
        return;
      }
      if (!options.approve || !options.sshKey) {
        if (options.json) printJson({ plan });
        else console.log(`Review the plan, then apply it with:\n  vibe deploy shared-hosting --application ${plan.application} --environment ${plan.environment} --revision ${plan.sourceRevision} --mode ${plan.mode} --host ${plan.host} --user ${plan.user} --remote-root ${plan.remoteRoot} --health-url ${plan.healthUrl} --ssh-key /absolute/path --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`);
        process.exitCode = 2;
        return;
      }
      const result = await executeSharedHostingPlan(plan, { approval: options.approve, repositoryRoot: process.cwd(), sshKeyPath: options.sshKey, productionApproved: options.productionApproved ?? false });
      await new FileStateStore(process.cwd()).recordRelease(result.release);
      if (options.json) printJson({ plan, release: result.release });
      else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} Recorded ${result.release.id} as ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.shared_hosting_failed", error, options.json ?? false); }
  });

deploy.command("shared-hosting-rollback")
  .description("Apply an exact-approved rollback by repointing the remote current symlink")
  .requiredOption("--release <id>", "unhealthy or failed release identifier")
  .requiredOption("--host <host>", "SSH hostname with a pinned known-host entry")
  .requiredOption("--user <user>", "non-root SSH deployment user")
  .requiredOption("--remote-root <path>", "versioned remote deployment root")
  .requiredOption("--health-url <url>", "externally reachable HTTP(S) health URL")
  .requiredOption("--ssh-key <path>", "absolute private key path; never stored in the plan")
  .requiredOption("--approve <digest>", "approve the exact rollback plan digest")
  .option("--production-approved", "separately approve a production rollback")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { release: string; host: string; user: string; remoteRoot: string; healthUrl: string; sshKey: string; approve: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const store = new FileStateStore(process.cwd());
      const releases = await store.releases();
      const plan = createRollbackPlan(releases, options.release);
      const result = await executeSharedHostingRollback(plan, releases, { approval: options.approve, host: options.host, user: options.user, remoteRoot: options.remoteRoot, healthUrl: options.healthUrl, sshKeyPath: options.sshKey, productionApproved: options.productionApproved ?? false });
      await store.commitRollback(releases.filter(({ id }) => id === plan.failedReleaseId || id === plan.targetReleaseId), result.failed, result.release);
      if (options.json) printJson({ plan, release: result.release });
      else console.log(`${result.release.status === "healthy" ? "✓" : "✗"} Rollback release ${result.release.id} is ${result.release.status}`);
      process.exitCode = result.release.status === "healthy" ? 0 : 1;
    } catch (error) { printDeploymentError("deployment.shared_hosting_rollback_failed", error, options.json ?? false); }
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
  .option("--reviewers <logins>", "comma-separated GitHub usernames required to review production deployments")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { repository: string; manifest: string; apply?: boolean; approve?: string; productionApproved?: boolean; reviewers?: string; json?: boolean }) => {
    try {
      const manifest = await loadManifest(resolve(process.cwd(), options.manifest));
      const reviewers = options.reviewers ? options.reviewers.split(",") : [];
      const plan = createGitHubEnvironmentPlan(manifest, options.repository, reviewers);
      if (!options.apply) {
        if (options.json) printJson(plan);
        else { console.log(`Repository: ${plan.repository}`); for (const environment of plan.environments) console.log(`• ${environment.name} (${environment.secretNames.length} secret name contract(s))`); if (plan.productionReviewers.length) console.log(`Production reviewers: ${plan.productionReviewers.join(", ")}`); console.log(`Plan digest: ${plan.digest}`); }
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

const database = program.command("db").description("Inspect, migrate, seed, backup, and restore databases through exact-approved plans");

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
  .command("inspect-provider")
  .description("Inspect an existing hosted database project through its authenticated API")
  .requiredOption("--provider <provider>", "hosted provider, currently neon")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { provider: string; json?: boolean }) => {
    try {
      const result = await inspectHostedDatabase(options.provider, process.env);
      if (options.json) printJson(result);
      else {
        console.log(`${result.provider}${result.projectId ? ` ${result.projectId}` : ""}${result.name ? ` (${result.name})` : ""}${result.region ? ` ${result.region}` : ""}`);
        if (result.diagnostics.length) printDiagnostics(result.diagnostics, false);
      }
    } catch (error) { printDatabaseError(error, options.json ?? false); }
  });

database
  .command("branch")
  .description("Plan or create a branch on an existing Neon project without returning connection URIs")
  .requiredOption("--provider <provider>", "hosted provider, currently neon")
  .requiredOption("--name <branch>", "lowercase branch name")
  .option("-e, --environment <name>", "target environment", "staging")
  .option("--apply", "create the branch after exact digest approval")
  .option("--approve <digest>", "approve the exact branch plan digest")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { provider: string; name: string; environment: string; apply?: boolean; approve?: string; json?: boolean }) => {
    try {
      if (options.provider !== "neon") throw new Error("Branch create is implemented for neon; other providers remain inspect-only");
      const plan = createNeonBranchPlan({ branchName: options.name, environment: options.environment, environmentVariables: process.env });
      if (!options.apply) {
        if (options.json) printJson({ plan });
        else {
          console.log(`Neon project ${plan.projectId}  branch ${plan.branchName}  ${plan.environment}`);
          console.log(`Plan digest: ${plan.digest}`);
          console.log("No branch was created.");
        }
        return;
      }
      const token = process.env.NEON_API_KEY;
      if (!options.approve || !token) {
        if (options.json) printJson({ plan });
        else console.log(`Set NEON_API_KEY and NEON_PROJECT_ID, then apply with --apply --approve ${plan.digest}`);
        process.exitCode = 2;
        return;
      }
      const result = await executeNeonBranchPlan(plan, { approval: options.approve, token });
      if (options.json) printJson({ plan, result });
      else console.log(`✓ Created Neon branch ${result.branchName} (${result.branchId})`);
    } catch (error) { printDatabaseError(error, options.json ?? false); }
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
  .description("Inspect Drizzle, TypeORM, MikroORM, Mongoose, or declarative MongoDB migrations offline")
  .requiredOption("--tool <tool>", "drizzle, mongodb, typeorm, mikro-orm, or mongoose")
  .option("--path <path>", "migration directory")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { tool: string; path?: string; json?: boolean }) => {
    try {
      const result = options.tool === "drizzle" ? await inspectDrizzleMigrations(process.cwd(), options.path ?? "drizzle")
        : options.tool === "mongodb" ? await inspectMongoMigrations(process.cwd(), options.path ?? "migrations/mongodb")
        : options.tool === "typeorm" ? await inspectTypeOrmMigrations(process.cwd(), options.path ?? "src/migrations")
        : options.tool === "mikro-orm" ? await inspectMikroOrmMigrations(process.cwd(), options.path ?? "src/migrations")
        : options.tool === "mongoose" ? await inspectMongooseMigrations(process.cwd(), options.path ?? "migrations/mongoose")
        : (() => { throw new Error(`Unknown tooling adapter ${JSON.stringify(options.tool)}; expected drizzle, mongodb, typeorm, mikro-orm, or mongoose`); })();
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

database
  .command("migrate")
  .description("Plan or apply exact-approved Prisma, Drizzle, TypeORM, MikroORM, or declarative MongoDB migrations")
  .requiredOption("--tool <tool>", "prisma, drizzle, mongodb, typeorm, or mikro-orm")
  .option("--engine <engine>", "database engine when not inferred from Prisma")
  .option("-s, --schema <path>", "Prisma schema path", "prisma/schema.prisma")
  .option("--datasource <path>", "TypeORM DataSource path", "src/data-source.ts")
  .option("--config <path>", "MikroORM config path")
  .option("--path <path>", "migration directory")
  .option("-e, --environment <name>", "target environment", "dev")
  .option("--allow-destructive", "include destructive statements in the approved plan")
  .option("--backup-checksum <sha256>", "verified backup checksum required for production destructive migrations")
  .option("--apply", "execute the exact-approved plan")
  .option("--approve <digest>", "approve the exact migration plan digest")
  .option("--production-approved", "separately approve a production migration")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { tool: string; engine?: string; schema: string; datasource: string; config?: string; path?: string; environment: string; allowDestructive?: boolean; backupChecksum?: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      if (options.tool !== "prisma" && options.tool !== "drizzle" && options.tool !== "mongodb" && options.tool !== "typeorm" && options.tool !== "mikro-orm") {
        throw new Error("Migration execution supports prisma, drizzle, mongodb, typeorm, or mikro-orm");
      }
      const inspected = options.tool === "prisma"
        ? await inspectPrismaDatabase(process.cwd(), options.schema)
        : options.tool === "drizzle"
          ? await inspectDrizzleMigrations(process.cwd(), options.path ?? "drizzle")
          : options.tool === "typeorm"
            ? await inspectTypeOrmMigrations(process.cwd(), options.path ?? "src/migrations")
            : options.tool === "mikro-orm"
              ? await inspectMikroOrmMigrations(process.cwd(), options.path ?? "src/migrations")
              : await inspectMongoMigrations(process.cwd(), options.path ?? "migrations/mongodb");
      const engine = options.tool === "prisma" ? ("provider" in inspected ? inspected.provider : "postgresql") : (options.engine ?? (options.tool === "mongodb" ? "mongodb" : "postgresql"));
      const migrationsPath = "migrationsPath" in inspected ? inspected.migrationsPath : inspected.path;
      const schemaPath = options.tool === "prisma"
        ? ("schemaPath" in inspected ? inspected.schemaPath : undefined)
        : options.tool === "typeorm"
          ? options.datasource
          : options.tool === "mikro-orm"
            ? options.config
            : undefined;
      const plan = createDatabaseMigratePlan({
        tool: options.tool, engine, environment: options.environment, risk: inspected.risk, migrationsPath,
        migrationChecksums: inspected.migrations.map(({ name, checksum }) => ({ name, checksum })),
        ...(schemaPath ? { schemaPath } : {}), ...(options.allowDestructive ? { allowDestructive: true } : {}),
        ...(options.backupChecksum ? { backupChecksum: options.backupChecksum } : {}),
      });
      await runDatabasePlan(plan, options);
    } catch (error) { printDatabaseError(error, options.json ?? false); }
  });

database
  .command("seed")
  .description("Plan or apply an exact-approved Prisma database seed")
  .option("-s, --schema <path>", "Prisma schema path", "prisma/schema.prisma")
  .option("--engine <engine>", "database engine", "postgresql")
  .option("-e, --environment <name>", "target environment", "dev")
  .option("--apply", "execute the exact-approved plan")
  .option("--approve <digest>", "approve the exact seed plan digest")
  .option("--production-approved", "separately approve a production seed")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { schema: string; engine: string; environment: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const plan = createDatabaseSeedPlan({ environment: options.environment, engine: options.engine, schemaPath: options.schema });
      await runDatabasePlan(plan, options);
    } catch (error) { printDatabaseError(error, options.json ?? false); }
  });

database
  .command("backup")
  .description("Plan or create a checksummed database backup without putting credentials in arguments")
  .requiredOption("--engine <engine>", "postgresql, mysql, mariadb, sqlite, or mongodb")
  .option("-e, --environment <name>", "target environment", "dev")
  .option("--url-variable <name>", "environment variable holding the connection URL")
  .option("--apply", "execute the exact-approved plan")
  .option("--approve <digest>", "approve the exact backup plan digest")
  .option("--production-approved", "separately approve a production backup")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { engine: string; environment: string; urlVariable?: string; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const plan = createDatabaseBackupPlan({ engine: options.engine, environment: options.environment, ...(options.urlVariable ? { urlVariableName: options.urlVariable } : {}) });
      await runDatabasePlan(plan, options);
    } catch (error) { printDatabaseError(error, options.json ?? false); }
  });

database
  .command("restore")
  .description("Plan or restore a checksummed backup; production requires separate approval")
  .requiredOption("--engine <engine>", "postgresql, mysql, mariadb, sqlite, or mongodb")
  .requiredOption("--backup <path>", "repository-relative backup file")
  .requiredOption("--backup-checksum <sha256>", "SHA-256 of the backup file")
  .option("-e, --environment <name>", "target environment", "dev")
  .option("--url-variable <name>", "environment variable holding the connection URL")
  .option("--allow-destructive", "include restore in the approved plan")
  .option("--apply", "execute the exact-approved plan")
  .option("--approve <digest>", "approve the exact restore plan digest")
  .option("--production-approved", "separately approve a production restore")
  .option("--json", "print machine-readable JSON")
  .action(async (options: { engine: string; backup: string; backupChecksum: string; environment: string; urlVariable?: string; allowDestructive?: boolean; apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }) => {
    try {
      const plan = createDatabaseRestorePlan({ engine: options.engine, environment: options.environment, backupPath: options.backup, backupChecksum: options.backupChecksum, ...(options.urlVariable ? { urlVariableName: options.urlVariable } : {}), ...(options.allowDestructive ? { allowDestructive: true } : {}) });
      await runDatabasePlan(plan, options);
    } catch (error) { printDatabaseError(error, options.json ?? false); }
  });

let releaseDeploymentLease: (() => Promise<void>) | undefined;
let deploymentAttempt: DeploymentAttempt | undefined;
const deploymentAttemptStore = new FileStateStore(process.cwd());
program.hook("preAction", async (_program, command) => {
  const parent = command.parent?.name();
  const options = command.opts();
  const name = command.name();
  const mutatingDeployment = parent === "deploy" && (
    options.apply === true || name.endsWith("-rollback") || name === "verify-health"
  );
  const mutatingExpo = parent === "expo" && options.apply === true;
  const reconciliation = name === "reconcile" && options.apply === true;
  if (mutatingDeployment || mutatingExpo || reconciliation) {
    releaseDeploymentLease = await new FileStateStore(process.cwd()).acquireDeploymentLease();
    deploymentAttempt = await deploymentAttemptStore.startDeploymentAttempt(reconciliation ? "reconcile" : `${parent} ${name}`);
  }
});
try {
  await program.parseAsync();
} catch (error) {
  printDeploymentError("deployment.operation_failed", error, process.argv.includes("--json"));
} finally {
  let recorded = true;
  if (deploymentAttempt) {
    try {
      await deploymentAttemptStore.finishDeploymentAttempt(deploymentAttempt, Number(process.exitCode ?? 0));
    } catch (error) {
      recorded = false;
      printDeploymentError("deployment.attempt_record_failed", error, process.argv.includes("--json"));
    }
  }
  // Keep the lease when completion could not be recorded, preventing blind retry.
  if (recorded) await releaseDeploymentLease?.();
}

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
  if (status === "succeeded" || status === "healthy") return "✓";
  if (status === "failed" || status === "unhealthy") return "✗";
  if (status === "rolled-back") return "↶";
  return "•";
}

function parseInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer`);
  return Number(value);
}

function printDeploymentError(code: string, error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  printDiagnostics([{ code, severity: "error", component: "deployment", message }], json);
  process.exitCode = 1;
}

function riskSymbol(risk: string): string {
  if (risk === "safe") return "✓";
  if (risk === "destructive") return "✗";
  return "!";
}

function supportSymbol(support: string): string {
  return support === "implemented" ? "✓" : "○";
}

async function runExpoPlan(plan: ExpoEasPlan, options: { apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }): Promise<void> {
  if (!options.apply) {
    if (options.json) printJson({ plan });
    else {
      console.log(`Expo ${plan.operation}  ${plan.application}  ${plan.environment}  ${plan.sourceRevision}`);
      console.log(`Required secret names: ${plan.requiredSecretNames.join(", ")}`);
      console.log(`Plan digest: ${plan.digest}`);
      console.log("No EAS command was run.");
    }
    return;
  }
  const token = process.env.EXPO_TOKEN;
  if (!options.approve || !token) {
    if (options.json) printJson({ plan });
    else console.log(`Set EXPO_TOKEN, then apply with --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`);
    process.exitCode = 2;
    return;
  }
  const result = await executeExpoEasPlan(plan, { approval: options.approve, repositoryRoot: process.cwd(), token, productionApproved: options.productionApproved ?? false });
  await new FileStateStore(process.cwd()).recordRelease(result.release);
  if (options.json) printJson({ plan, release: result.release, output: result.output });
  else {
    console.log(`${result.release.status === "healthy" ? "✓" : "•"} Recorded ${result.release.id} as ${result.release.status}`);
    if (result.output) console.log(result.output);
  }
  process.exitCode = result.release.status === "failed" || result.release.status === "unhealthy" ? 1 : 0;
}

async function runDatabasePlan(plan: DatabaseOperationPlan, options: { apply?: boolean; approve?: string; productionApproved?: boolean; json?: boolean }): Promise<void> {
  if (!options.apply) {
    if (options.json) printJson({ plan });
    else {
      console.log(`Operation: ${plan.operation}  engine: ${plan.engine}  environment: ${plan.environment}  risk: ${plan.risk}`);
      console.log(`Required secret names: ${plan.requiredSecretNames.join(", ")}`);
      if (plan.command) console.log(`Command: ${plan.command.executable} ${plan.command.args.join(" ")}`);
      console.log(`Plan digest: ${plan.digest}`);
      console.log("No database was changed.");
    }
    return;
  }
  if (!options.approve) {
    if (options.json) printJson({ plan });
    else console.log(`Review the plan, then apply it with --apply --approve ${plan.digest}${plan.environment === "production" ? " --production-approved" : ""}`);
    process.exitCode = 2;
    return;
  }
  const result = await executeDatabaseOperationPlan(plan, { approval: options.approve, repositoryRoot: process.cwd(), productionApproved: options.productionApproved ?? false });
  if (options.json) printJson({ plan, result });
  else {
    console.log(`✓ ${plan.operation} ${result.status}`);
    if (result.backup) console.log(`Backup: ${result.backup.path}  checksum ${result.backup.checksum}`);
    if (result.output) console.log(result.output);
  }
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
