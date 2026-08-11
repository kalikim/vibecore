import type {
  Diagnostic,
  ProjectEdge,
  ProjectGraph,
  ProjectNode,
  VibecoreManifest,
} from "@vibecore/contracts";

export function buildProjectGraph(manifest: VibecoreManifest): ProjectGraph {
  const nodes: ProjectNode[] = [];
  const edges: ProjectEdge[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const [name, application] of Object.entries(manifest.applications)) {
    nodes.push({ id: applicationId(name), name, kind: "application", data: application });
  }

  for (const [name, resource] of Object.entries(manifest.resources ?? {})) {
    nodes.push({ id: resourceId(name), name, kind: "resource", data: resource });
  }

  for (const [name, environment] of Object.entries(manifest.environments)) {
    nodes.push({ id: environmentId(name), name, kind: "environment", data: environment });
  }

  for (const [name, application] of Object.entries(manifest.applications)) {
    for (const dependency of application.dependsOn ?? []) {
      const target = dependency in manifest.applications
        ? applicationId(dependency)
        : dependency in (manifest.resources ?? {})
          ? resourceId(dependency)
          : undefined;

      if (!target) {
        diagnostics.push({
          code: "graph.dependency.missing",
          severity: "error",
          component: name,
          message: `${name} depends on unknown component: ${dependency}`,
        });
        continue;
      }

      edges.push({ from: applicationId(name), to: target, kind: "depends-on" });
    }
  }

  diagnostics.push(...detectApplicationCycles(nodes, edges));
  return { nodes, edges, diagnostics };
}

export function topologicalApplications(graph: ProjectGraph): string[] {
  const applicationNodes = graph.nodes.filter(({ kind }) => kind === "application");
  const applicationIds = new Set(applicationNodes.map(({ id }) => id));
  const dependencies = new Map<string, Set<string>>(
    applicationNodes.map(({ id }) => [id, new Set<string>()]),
  );

  for (const edge of graph.edges) {
    if (applicationIds.has(edge.from) && applicationIds.has(edge.to)) {
      dependencies.get(edge.from)?.add(edge.to);
    }
  }

  const ordered: string[] = [];
  const remaining = new Map([...dependencies].map(([id, values]) => [id, new Set(values)]));

  while (remaining.size > 0) {
    const ready = [...remaining.entries()]
      .filter(([, values]) => values.size === 0)
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) return [];

    for (const id of ready) {
      ordered.push(id.slice("application:".length));
      remaining.delete(id);
      for (const values of remaining.values()) values.delete(id);
    }
  }

  return ordered;
}

function detectApplicationCycles(nodes: ProjectNode[], edges: ProjectEdge[]): Diagnostic[] {
  const applicationIds = new Set(
    nodes.filter(({ kind }) => kind === "application").map(({ id }) => id),
  );
  const adjacency = new Map<string, string[]>();
  for (const id of applicationIds) adjacency.set(id, []);
  for (const edge of edges) {
    if (applicationIds.has(edge.from) && applicationIds.has(edge.to)) {
      adjacency.get(edge.from)?.push(edge.to);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(id: string): string[] | undefined {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return undefined;

    visiting.add(id);
    stack.push(id);
    for (const target of adjacency.get(id) ?? []) {
      const cycle = visit(target);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  }

  for (const id of [...applicationIds].sort()) {
    const cycle = visit(id);
    if (cycle) {
      return [{
        code: "graph.dependency.cycle",
        severity: "error",
        component: "project-graph",
        message: `Application dependency cycle: ${cycle.map((value) => value.slice("application:".length)).join(" -> ")}`,
      }];
    }
  }
  return [];
}

const applicationId = (name: string) => `application:${name}`;
const resourceId = (name: string) => `resource:${name}`;
const environmentId = (name: string) => `environment:${name}`;
