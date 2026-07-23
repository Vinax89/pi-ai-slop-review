import { GraphStore } from "../graph/store.ts";
import type { GraphEdge, GraphNode } from "../graph/types.ts";

export interface RetrievedContext {
  query: string;
  results: Array<{
    node: GraphNode;
    score: number;
    reasons: string[];
    incoming: GraphEdge[];
    outgoing: GraphEdge[];
  }>;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9_]+/).filter((token) => token.length > 1));
}

export function retrieveRepositoryContext(rootDir: string, query: string, limit = 20, stateRoot?: string): RetrievedContext {
  if (!query.trim()) throw new Error("retrieval query is required");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("retrieval limit must be between 1 and 100");
  const store = new GraphStore(rootDir, stateRoot);
  try {
    const queryTokens = tokens(query);
    const edges = store.edges();
    const results = store.nodes().flatMap((node) => {
      const nodeTokens = tokens(`${node.name} ${node.qualifiedName} ${node.filePath} ${node.signature ?? ""}`);
      const overlap = [...queryTokens].filter((token) => nodeTokens.has(token));
      const exact = node.name.toLowerCase() === query.trim().toLowerCase() || node.qualifiedName.toLowerCase() === query.trim().toLowerCase();
      const incoming = edges.filter((edge) => edge.toId === node.id).slice(0, 100);
      const outgoing = edges.filter((edge) => edge.fromId === node.id).slice(0, 100);
      const score = (exact ? 1 : 0) + overlap.length / Math.max(1, queryTokens.size) + (node.exported ? 0.1 : 0) + Math.min(0.2, incoming.length * 0.01);
      if (!exact && !overlap.length) return [];
      return [{
        node,
        score,
        reasons: [
          ...(exact ? ["exact symbol match"] : []),
          ...(overlap.length ? [`token overlap: ${overlap.join(", ")}`] : []),
          ...(node.exported ? ["public-surface symbol"] : []),
          ...(incoming.length ? [`${incoming.length} incoming edge(s)`] : []),
        ],
        incoming,
        outgoing,
      }];
    });
    results.sort((left, right) => right.score - left.score || left.node.filePath.localeCompare(right.node.filePath));
    return { query, results: results.slice(0, limit) };
  } finally {
    store.close();
  }
}
