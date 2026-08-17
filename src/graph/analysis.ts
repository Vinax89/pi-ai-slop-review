import type { GraphEdge, GraphNode } from "./types.ts";

export interface ImportCycle {
  files: string[];
  edgeIds: string[];
  typeOnlyEdgeIds: string[];
}

/**
 * Find file-level import cycles from resolved repository edges. Components are
 * canonicalized so output is stable across SQLite and traversal ordering.
 */
export function importCycles(nodes: GraphNode[], edges: GraphEdge[]): ImportCycle[] {
  const filesById = new Map(nodes.filter((node) => node.kind === "file").map((node) => [node.id, node.filePath]));
  const adjacency = new Map<string, Array<{ to: string; edgeId: string }>>();
  for (const edge of edges) {
    if (edge.kind !== "imports" || !filesById.has(edge.fromId) || !filesById.has(edge.toId)) continue;
    const outgoing = adjacency.get(edge.fromId) ?? [];
    outgoing.push({ to: edge.toId, edgeId: edge.id });
    adjacency.set(edge.fromId, outgoing);
  }
  for (const outgoing of adjacency.values()) outgoing.sort((left, right) => left.to.localeCompare(right.to) || left.edgeId.localeCompare(right.edgeId));

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (id: string): void => {
    indices.set(id, nextIndex);
    lowLinks.set(id, nextIndex++);
    stack.push(id);
    onStack.add(id);
    for (const { to } of adjacency.get(id) ?? []) {
      if (!indices.has(to)) {
        visit(to);
        lowLinks.set(id, Math.min(lowLinks.get(id)!, lowLinks.get(to)!));
      } else if (onStack.has(to)) {
        lowLinks.set(id, Math.min(lowLinks.get(id)!, indices.get(to)!));
      }
    }
    if (lowLinks.get(id) !== indices.get(id)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== id);
    components.push(component);
  };

  for (const id of [...filesById.keys()].sort()) if (!indices.has(id)) visit(id);
  return components.flatMap((component) => {
    const members = new Set(component);
    const internalEdges = component.flatMap((id) => (adjacency.get(id) ?? []).filter((edge) => members.has(edge.to)));
    if (component.length === 1 && !internalEdges.some((edge) => edge.to === component[0])) return [];
    return [{
      files: component.map((id) => filesById.get(id)!).sort(),
      edgeIds: internalEdges.map((edge) => edge.edgeId).sort(),
      typeOnlyEdgeIds: edges
        .filter((edge) => internalEdges.some((internal) => internal.edgeId === edge.id) && edge.metadata.typeOnly === true)
        .map((edge) => edge.id)
        .sort(),
    }];
  }).sort((left, right) => left.files.join("\0").localeCompare(right.files.join("\0")));
}
