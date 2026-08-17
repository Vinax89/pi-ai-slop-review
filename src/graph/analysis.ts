import type { GraphEdge, GraphNode } from "./types.ts";

export interface ImportCycle {
  files: string[];
  edgeIds: string[];
  typeOnlyEdgeIds: string[];
}

function safePathLabel(value: string, maxLength = 120): string {
  const printable = value.replace(/[\u0000-\u001f\u007f]/g, "?");
  return printable.length <= maxLength ? printable : `${printable.slice(0, maxLength - 1)}…`;
}

export function formatImportCycle(files: string[], maxFiles = 8): string {
  const shown = files.slice(0, maxFiles).map((file) => safePathLabel(file));
  const omitted = Math.max(0, files.length - shown.length);
  return `${shown.join(" -> ")}${omitted ? ` (+${omitted} more)` : ""}`;
}

/**
 * Find file-level import cycles from resolved repository edges. Components are
 * canonicalized so output is stable across SQLite and traversal ordering.
 */
export function importCycles(nodes: GraphNode[], edges: GraphEdge[]): ImportCycle[] {
  const filesById = new Map(nodes.filter((node) => node.kind === "file").map((node) => [node.id, node.filePath]));
  const adjacency = new Map<string, Array<{ to: string; edgeId: string }>>();
  const reverse = new Map<string, string[]>();
  const typeOnlyIds = new Set(edges.filter((edge) => edge.metadata.typeOnly === true).map((edge) => edge.id));
  for (const edge of edges) {
    if (edge.kind !== "imports" || !filesById.has(edge.fromId) || !filesById.has(edge.toId)) continue;
    const outgoing = adjacency.get(edge.fromId) ?? [];
    outgoing.push({ to: edge.toId, edgeId: edge.id });
    adjacency.set(edge.fromId, outgoing);
    const incoming = reverse.get(edge.toId) ?? [];
    incoming.push(edge.fromId);
    reverse.set(edge.toId, incoming);
  }
  for (const outgoing of adjacency.values()) outgoing.sort((left, right) => left.to.localeCompare(right.to) || left.edgeId.localeCompare(right.edgeId));
  for (const incoming of reverse.values()) incoming.sort();

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
      for (const previous of reverse.get(current) ?? []) {
        if (assigned.has(previous)) continue;
        assigned.add(previous);
        stack.push(previous);
      }
    }
    components.push(component);
  }
  return components.flatMap((component) => {
    const members = new Set(component);
    const internalEdges = component.flatMap((id) => (adjacency.get(id) ?? []).filter((edge) => members.has(edge.to)));
    if (component.length === 1 && !internalEdges.some((edge) => edge.to === component[0])) return [];
    return [{
      files: component.map((id) => filesById.get(id)!).sort(),
      edgeIds: internalEdges.map((edge) => edge.edgeId).sort(),
      typeOnlyEdgeIds: internalEdges
        .filter((edge) => typeOnlyIds.has(edge.edgeId))
        .map((edge) => edge.edgeId)
        .sort(),
    }];
  }).sort((left, right) => left.files.join("\0").localeCompare(right.files.join("\0")));
}
