import type { GraphEdge, GraphNode } from "./types.ts";

export interface ImportCycle {
  files: string[];
  edgeCount: number;
  typeOnlyEdgeCount: number;
}

function safePathLabel(value: string, maxLength = 120): string {
  const printable = value.replace(/[\u0000-\u001f\u007f]/g, "?");
  return printable.length <= maxLength ? printable : `${printable.slice(0, maxLength - 1)}…`;
}

export function formatImportCycle(files: string[], maxFiles = 8): string {
  const shown = files.slice(0, maxFiles).map((file) => safePathLabel(file));
  const omitted = Math.max(0, files.length - shown.length);
  return `${shown.join(", ")}${omitted ? ` (+${omitted} more)` : ""}`;
}

/**
 * Find file-level import cycles from resolved repository edges. Components are
 * canonicalized so output is stable across SQLite and traversal ordering.
 */
export function importCycles(nodes: GraphNode[], edges: GraphEdge[], maxCycles = Number.MAX_SAFE_INTEGER, runtimeOnly = false): ImportCycle[] {
  const limit = Math.max(0, Math.floor(maxCycles));
  if (limit === 0) return [];
  const filesById = new Map(nodes.filter((node) => node.kind === "file").map((node) => [node.id, node.filePath]));
  const adjacency = new Map<string, Array<{ to: string; typeOnly: boolean }>>();
  const reverse = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.kind !== "imports" || !filesById.has(edge.fromId) || !filesById.has(edge.toId)) continue;
    const outgoing = adjacency.get(edge.fromId) ?? [];
    outgoing.push({ to: edge.toId, typeOnly: edge.metadata.typeOnly === true });
    adjacency.set(edge.fromId, outgoing);
    const incoming = reverse.get(edge.toId) ?? new Set<string>();
    incoming.add(edge.fromId);
    reverse.set(edge.toId, incoming);
  }
  for (const outgoing of adjacency.values()) {
    outgoing.sort((left, right) => left.to.localeCompare(right.to) || Number(left.typeOnly) - Number(right.typeOnly));
  }

  const visited = new Set<string>();
  const finishOrder: string[] = [];
  for (const start of [...filesById.keys()].sort()) {
    if (visited.has(start)) continue;
    const stack: Array<{ id: string; expanded: boolean }> = [{ id: start, expanded: false }];
    while (stack.length) {
      const current = stack.pop()!;
      if (current.expanded) {
        finishOrder.push(current.id);
        continue;
      }
      if (visited.has(current.id)) continue;
      visited.add(current.id);
      stack.push({ id: current.id, expanded: true });
      const outgoing = adjacency.get(current.id) ?? [];
      for (let index = outgoing.length - 1; index >= 0; index -= 1) {
        if (!visited.has(outgoing[index]!.to)) stack.push({ id: outgoing[index]!.to, expanded: false });
      }
    }
  }

  const components: string[][] = [];
  const assigned = new Set<string>();
  for (const start of finishOrder.reverse()) {
    if (assigned.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    assigned.add(start);
    while (stack.length) {
      const current = stack.pop()!;
      component.push(current);
      for (const previous of [...(reverse.get(current) ?? [])].sort()) {
        if (assigned.has(previous)) continue;
        assigned.add(previous);
        stack.push(previous);
      }
    }
    components.push(component);
  }
  const ordered = components.map((component) => ({
    component,
    files: component.map((id) => filesById.get(id)!).sort(),
  })).filter(({ component }) => component.length > 1 || (adjacency.get(component[0]!) ?? []).some((edge) => edge.to === component[0]))
    .sort((left, right) => left.files.join("\0").localeCompare(right.files.join("\0")));
  const cycles: ImportCycle[] = [];
  for (const { component, files } of ordered) {
    const members = new Set(component);
    const internalEdges = component.flatMap((id) => (adjacency.get(id) ?? []).filter((edge) => members.has(edge.to)));
    const cycle = {
      files,
      edgeCount: internalEdges.length,
      typeOnlyEdgeCount: internalEdges.filter((edge) => edge.typeOnly).length,
    };
    if (!runtimeOnly || cycle.typeOnlyEdgeCount < cycle.edgeCount) cycles.push(cycle);
    if (cycles.length >= limit) break;
  }
  return cycles;
}
