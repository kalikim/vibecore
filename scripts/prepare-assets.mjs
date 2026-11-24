import { copyFile, mkdir, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Keep the root schema authoritative while making the config package portable.
const target = new URL("../packages/config/schemas/", import.meta.url);
await mkdir(target, { recursive: true });
await copyFile(
  new URL("../schemas/vibecore.schema.json", import.meta.url),
  fileURLToPath(new URL("vibecore.schema.json", target)),
);

// Each distributed workspace package must carry the full first-party license.
for (const parent of ["apps", "packages"]) {
  const base = new URL(`../${parent}/`, import.meta.url);
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await copyFile(new URL("../LICENSE", import.meta.url), new URL(`${entry.name}/LICENSE`, base));
  }
}
