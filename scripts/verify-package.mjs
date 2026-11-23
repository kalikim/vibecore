import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "vibecore-package-check-"));
const target = join(temp, "cli");
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", timeout: 180_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

async function checkLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const rel = relative(target, await realpath(path));
      if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
        throw new Error(`Package contains an external symlink: ${path}`);
      }
    } else if (entry.isDirectory()) await checkLinks(path);
  }
}

try {
  // No publication or remote deployment: create an isolated production install.
  run("pnpm", ["--filter", "@vibecore/cli", "deploy", "--prod", "--offline", target]);
  await checkLinks(target);
  run(process.execPath, ["--test", "tests/cli.smoke.mjs"], {
    ...process.env, VIBECORE_TEST_ENTRY: join(target, "dist/index.js"),
  });
  console.log("Portable production install passed; no package was published.");
} finally {
  await rm(temp, { recursive: true, force: true });
}
