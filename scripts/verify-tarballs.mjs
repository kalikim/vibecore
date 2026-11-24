import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const { parse } = createRequire(new URL("../apps/cli/package.json", import.meta.url))("yaml");

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "vibecore-tarball-check-"));
const archives = join(temporary, "archives");
const consumer = join(temporary, "consumer");
function run(command, args, cwd = root, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  await mkdir(archives);
  await mkdir(consumer);
  const license = await readFile(join(root, "LICENSE"), "utf8");
  const workspace = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(workspace.private, true, "Workspace root must never be publishable");
  const names = new Set();
  const tarballs = [];
  const overrides = {};
  // Match the audited source lockfile instead of resolving newer semver matches.
  const lock = parse(await readFile(join(root, "pnpm-lock.yaml"), "utf8"));
  for (const key of Object.keys(lock.packages)) {
    const separator = key.lastIndexOf("@");
    const name = key.slice(0, separator);
    const version = key.slice(separator + 1);
    assert.ok(!overrides[name] || overrides[name] === version, `Multiple locked versions need explicit handling: ${name}`);
    overrides[name] = version;
  }
  for (const parent of ["apps", "packages"]) {
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, parent, entry.name);
      const source = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      assert.equal(source.license, "MIT");
      assert.equal(source.version, "0.1.0-alpha.1");
      assert.equal(source.private, false);
      assert.equal(source.publishConfig.access, "public");
      assert.equal(source.publishConfig.tag, "alpha");
      assert.equal(source.publishConfig.registry, "https://registry.npmjs.org/");
      assert.ok(!names.has(source.name));
      names.add(source.name);
      const archive = join(archives, `${source.name.replaceAll("/", "-").replace("@", "")}.tgz`);
      run("pnpm", ["pack", "--out", archive], directory);
      const files = run("tar", ["-tzf", archive]).trim().split("\n");
      for (const file of files) {
        assert.ok(/^package\/(?:package\.json|LICENSE|README(?:\.md)?|dist\/.+|schemas\/[^/]+\.json)$/.test(file), `Unexpected packed file: ${file}`);
        assert.ok(!file.split("/").includes(".."), `Unsafe packed path: ${file}`);
        assert.ok(!/\.test\.|(?:^|\/)\.env|\.pem$|\.key$/.test(file), `Unwanted packed file: ${file}`);
      }
      assert.equal(run("tar", ["-xOzf", archive, "package/LICENSE"]), license);
      const packed = JSON.parse(run("tar", ["-xOzf", archive, "package/package.json"]));
      assert.equal(packed.license, "MIT");
      assert.equal(packed.name, source.name);
      assert.equal(packed.version, source.version);
      for (const [name, version] of Object.entries(packed.dependencies ?? {})) {
        if (name.startsWith("@vibecore/")) assert.equal(version, source.version);
      }
      for (const value of Object.values(packed.dependencies ?? {})) {
        assert.ok(!/^(workspace:|link:|file:)/.test(value), "Packed dependency still points at a workspace");
      }
      if (source.name === "@vibecore/config") assert.ok(files.includes("package/schemas/vibecore.schema.json"));
      tarballs.push(archive);
      overrides[source.name] = `file:${archive}`;
    }
  }
  // Explicit local tarball dependencies avoid fetching unpublished workspace packages.
  assert.equal(tarballs.length, 16, "Review the publication set when adding packages");
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "vibecore-release-consumer", private: true, packageManager: workspace.packageManager, pnpm: { overrides } }));
  run("pnpm", ["add", "--offline", "--ignore-scripts", ...tarballs], consumer);
  const entry = join(consumer, "node_modules/@vibecore/cli/dist/index.js");
  console.log(run(process.execPath, ["--test", "tests/cli.smoke.mjs"], root, { ...process.env, VIBECORE_TEST_ENTRY: entry }));
  assert.match(run(join(consumer, "node_modules/.bin/vibe"), ["--help"], consumer), /Local-first application orchestration/);
  console.log(`${tarballs.length} MIT-licensed tarballs checked; installed CLI and bin passed. Nothing was published.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
