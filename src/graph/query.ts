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
      : store.findByName(normalized).slice(0, 50);
    return {
      query: normalized,
      nodes,
      impacts: nodes.slice(0, 20).map((node) => store.impact(node.id)),
      publicSurface: store.publicSurface().filter((entry) => nodes.some((node) => node.id === entry.id)),
    };
  } finally {
    store.close();
  }
}
