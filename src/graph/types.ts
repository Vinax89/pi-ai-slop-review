export type GraphNodeKind = "file" | "function" | "class" | "variable" | "import" | "test" | "specification" | "requirement" | "registration" | "dependency" | "external";
export type GraphEdgeKind = "contains" | "imports" | "calls" | "exports" | "covers" | "governs" | "registers" | "depends-on" | "duplicates";

export interface GraphNode {
  id: string;
  filePath: string;
  kind: GraphNodeKind;
  name: string;
  qualifiedName: string;
  start: number;
  end: number;
  exported: boolean;
  signature?: string;
  bodyHash?: string;
  metadata: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  filePath: string;
  fromId: string;
  toId: string;
  kind: GraphEdgeKind;
  confidence: "C1" | "C2" | "C3";
  metadata: Record<string, unknown>;
}

export interface GraphFileFacts {
  filePath: string;
  sourceHash: string;
  source?: string;
  language: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ImpactResult {
  symbolId: string;
  incoming: GraphEdge[];
  outgoing: GraphEdge[];
  impactedNodeIds: string[];
}

export interface PublicSurfaceEntry {
  id: string;
  filePath: string;
  qualifiedName: string;
  kind: GraphNodeKind;
  signature?: string;
}
