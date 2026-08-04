import { GraphStore } from "./store.ts";
import type { GraphNode, ImpactResult, PublicSurfaceEntry } from "./types.ts";

export interface ContextQueryResult {
  query: string;
  nodes: GraphNode[];
  impacts: ImpactResult[];
  publicSurface: PublicSurfaceEntry[];
}

export function queryContext(rootDir: string, query: string, stateRoot?: string): ContextQueryResult {
  const store = new GraphStore(rootDir, stateRoot);
  try {
    const normalized = query.trim();
    const nodes = normalized.includes("/")
      ? store.nodes(normalized)
      : store.findByName(normalized);
    return {
      query: normalized,
      nodes,
      impacts: nodes.slice(0, 20).map((node) => store.impact(node.id)),
      publicSurface: nodes.filter((node) => node.exported).map((node) => ({
        id: node.id,
        filePath: node.filePath,
        qualifiedName: node.qualifiedName,
        kind: node.kind,
        signature: node.signature,
      })),
    };
  } finally {
    store.close();
  }
}
