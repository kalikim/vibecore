import { describe, expect, it } from "vitest";
import { validateOpenApiDocument } from "./validation.js";

describe("OpenAPI quality gate", () => {
  it("finds duplicate IDs, missing parameters, unsecured sensitive routes, and coverage gaps", () => {
    const diagnostics = validateOpenApiDocument({
      openapi: "3.1.0", info: { title: "API", version: "1" }, servers: [{ url: "http://user:pass@localhost:3000" }],
      paths: {
        "/users/{id}": { get: { operationId: "read", responses: { "200": { description: "ok" } } } },
        "/admin": { get: { operationId: "read", responses: { "500": { description: "bad" } } } },
      },
    }, [{ method: "post", path: "/users", framework: "express", confidence: "high", evidence: [] }]);
    const codes = diagnostics.map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining(["api.docs.operation_id.duplicate", "api.docs.path_parameter.missing", "api.docs.sensitive_route.unsecured", "api.docs.route.undocumented", "api.docs.server.credentials"]));
  });

  it("accepts a secured, complete operation", () => {
    const diagnostics = validateOpenApiDocument({ openapi: "3.1.0", info: { title: "API", version: "1" }, security: [{ bearer: [] }], paths: { "/users/{id}": { get: { operationId: "getUser", parameters: [{ name: "id", in: "path", required: true }], responses: { "200": { description: "ok" } } } } } });
    expect(diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
  });
});
