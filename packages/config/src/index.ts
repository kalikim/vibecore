import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { parse } from "yaml";
import type { VibecoreManifest } from "@vibecore/contracts";

export class ManifestValidationError extends Error {
  constructor(
    message: string,
    readonly issues: ErrorObject[],
  ) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

const packageDirectory = dirname(fileURLToPath(import.meta.url));
const defaultSchemaPath = resolve(
  packageDirectory,
  "../../../schemas/vibecore.schema.json",
);

export async function loadManifest(
  manifestPath: string,
  schemaPath = defaultSchemaPath,
): Promise<VibecoreManifest> {
  const [manifestSource, schemaSource] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(schemaPath, "utf8"),
  ]);

  const document: unknown = parse(manifestSource);
  const schema: object = JSON.parse(schemaSource) as object;
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: false,
  });
  const validate = ajv.compile(schema);

  if (!validate(document)) {
    const issues = validate.errors ?? [];
    throw new ManifestValidationError(formatValidationMessage(issues), issues);
  }

  return document as VibecoreManifest;
}

function formatValidationMessage(issues: ErrorObject[]): string {
  const details = issues.map((issue) => {
    const location = issue.instancePath || "/";
    return `${location} ${issue.message ?? "is invalid"}`;
  });

  return `Invalid Vibecore manifest:\n${details.map((detail) => `- ${detail}`).join("\n")}`;
}
