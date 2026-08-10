import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifest } from "./index.js";

describe("loadManifest", () => {
  it("loads the reference manifest", async () => {
    const manifest = await loadManifest(
      resolve(import.meta.dirname, "../../../examples/vibecore.yaml"),
    );

    expect(manifest.metadata.name).toBe("biashara-hub");
    expect(Object.keys(manifest.applications)).toEqual(["web", "api", "mobile"]);
  });
});
