import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverApiRoutes } from "./routes.js";

describe("static API route discovery", () => {
  it("extracts literal routes and normalizes parameters without executing code", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-routes-"));
    await mkdir(join(root, "api"));
    await writeFile(join(root, "api/index.ts"), 'throw new Error("must not execute");\napp.get("/users/:id", handler);\napp.post("/users", handler);');
    const result = await discoverApiRoutes(root, { path: "api", framework: "express" });
    expect(result.routes.map(({ method, path }) => `${method} ${path}`)).toEqual(["post /users", "get /users/{id}"]);
  });

  it("marks Django route methods for review", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibecore-django-routes-"));
    await mkdir(join(root, "api"));
    await writeFile(join(root, "api/urls.py"), 'urlpatterns = [path("users/<uuid:id>/", views.user)]');
    const result = await discoverApiRoutes(root, { path: "api", framework: "django" });
    expect(result.routes[0]).toMatchObject({ method: "get", path: "/users/{id}", requiresReview: true });
    expect(result.diagnostics[0]?.code).toBe("api.docs.route.review");
  });
});
