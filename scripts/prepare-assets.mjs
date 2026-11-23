import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Keep the root schema authoritative while making the config package portable.
const target = new URL("../packages/config/schemas/", import.meta.url);
await mkdir(target, { recursive: true });
await copyFile(
  new URL("../schemas/vibecore.schema.json", import.meta.url),
  fileURLToPath(new URL("vibecore.schema.json", target)),
);
