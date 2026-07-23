import type { AiSlopConfig } from "../core/config.ts";
import { createScanResult, fingerprint } from "../core/schema.ts";
import { offsetRange, safeProjectFile } from "../providers/files.ts";
import { SCHEMA_VERSION, type EvidenceRecord, type FindingDraft, type ScanResult, type ScanScope, type SkippedFile } from "../types.ts";
import { buildGraphFacts } from "./build.ts";
import { GraphStore } from "./store.ts";
import type { GraphNode, PublicSurfaceEntry } from "./types.ts";

function matches(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pathMatches(filePath, pattern));
}

function pathMatches(filePath: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`).test(filePath);
}

function layerFor(filePath: string, config: AiSlopConfig): string | undefined {
  return config.graph.layers.find((layer) => matches(filePath, layer.patterns))?.name;
}

function surfaceDelta(before: PublicSurfaceEntry[], after: PublicSurfaceEntry[]): {
  added: PublicSurfaceEntry[];
  removed: PublicSurfaceEntry[];
  changed: Array<{ before: PublicSurfaceEntry; after: PublicSurfaceEntry }>;
} {
  const beforeMap = new Map(before.map((entry) => [entry.id, entry]));
  const afterMap = new Map(after.map((entry) => [entry.id, entry]));
  return {
    added: after.filter((entry) => !beforeMap.has(entry.id)),
    removed: before.filter((entry) => !afterMap.has(entry.id)),
    changed: after.flatMap((entry) => {
      const previous = beforeMap.get(entry.id);
      return previous && previous.signature !== entry.signature ? [{ before: previous, after: entry }] : [];
    }),
  };
}

function findingForNode(
  rootDir: string,
  node: GraphNode,
  values: Omit<FindingDraft, "filePath" | "line" | "column" | "start" | "end" | "sourceHash" | "anchor"> & { anchor: string },
): FindingDraft | undefined {
  const file = safeProjectFile(rootDir, node.filePath);
  if (!file) return undefined;
  return { ...offsetRange(node.filePath, file.source, node.start, node.end), ...values };
}

function evidenceForNode(
  rootDir: string,
  node: GraphNode,
  summary: string,
  kind: EvidenceRecord["kind"],
  details: Record<string, unknown>,
): EvidenceRecord | undefined {
  const file = safeProjectFile(rootDir, node.filePath);
  if (!file) return undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: fingerprint("evidence", { nodeId: node.id, provider: "repository-graph", summary, details }),
    providerId: "repository-graph",
    providerVersion: "1",
    kind,
    summary,
    strength: "C2",
    source: offsetRange(node.filePath, file.source, node.start, node.end),
    details,
  };
}

export async function collectGraphEvidence(
  rootDir: string,
  paths: string[],
  config: AiSlopConfig,
  signal?: AbortSignal,
  stateRoot?: string,
  mode: ScanScope["mode"] = "explicit",
): Promise<ScanResult> {
  if (!config.graph.enabled) {
    return createScanResult({
      engine: "provider-federation",
      engineVersion: "repository graph disabled",
      rootDir,
      providerId: "repository-graph",
      providerVersion: "1",
      providerCapabilities: ["symbols", "references", "call-hierarchy", "public-surface", "tests"],
      scannedFiles: [],
      findings: [],
      skipped: [{ filePath: "<graph>", reason: "repository graph is disabled by configuration", providerId: "repository-graph" }],
    });
  }

  const store = new GraphStore(rootDir, stateRoot);
  const beforeSurface = store.publicSurface();
  const findings: FindingDraft[] = [];
  const evidenceRecords: EvidenceRecord[] = [];
  const skipped: SkippedFile[] = [];
  try {
    const built = await buildGraphFacts(rootDir, paths, config, signal);
    for (const [filePath, reason] of Object.entries(built.errors)) skipped.push({ filePath, reason, providerId: "repository-graph" });
    for (const facts of built.facts) store.updateFile(facts);
    const reviewedFiles = built.facts.map((facts) => facts.filePath);
    const reviewedNodes = reviewedFiles.flatMap((filePath) => store.nodes(filePath));
    const allEdges = store.edges();

    for (const node of reviewedNodes) {
      if (node.bodyHash && ["function", "class"].includes(node.kind)) {
        const clones = store.clones(node.bodyHash).filter((candidate) => candidate.id !== node.id && candidate.kind === node.kind);
        if (clones.length) {
          const finding = findingForNode(rootDir, node, {
            anchor: `duplicate:${node.id}`,
            ruleId: "structure.duplicate-capability",
            classification: "waste_candidate",
            confidence: "C1",
            risk: "R2",
            maximumAction: "observe",
            message: `'${node.qualifiedName}' has an exact normalized body match in ${clones.map((item) => `${item.filePath}:${item.qualifiedName}`).join(", ")}`,
            evidence: ["repository graph found identical normalized function/class body hashes"],
            counterEvidence: [],
            unknown: ["duplicate bodies may intentionally implement separate contracts or boundaries"],
          });
          if (finding) findings.push(finding);
        }
      }

      if (node.exported && ["function", "class", "variable"].includes(node.kind)) {
        const callers = allEdges.filter((item) => item.toId === node.id && item.kind === "calls");
        const tests = allEdges.filter((item) => item.toId === node.id && item.kind === "covers");
        const governing = allEdges.filter((item) => item.toId === nodeIdForFile(node.filePath) && item.kind === "governs");
        const impact = evidenceForNode(rootDir, node, `repository impact for exported '${node.qualifiedName}'`, "reference", {
          callers: callers.map((item) => item.fromId),
          tests: tests.map((item) => item.fromId),
          governingSpecifications: governing.map((item) => item.fromId),
        });
        if (impact) evidenceRecords.push(impact);
        if (!tests.length && mode !== "repository") {
          const finding = findingForNode(rootDir, node, {
            anchor: `tests:${node.id}`,
            ruleId: "assurance.no-linked-tests",
            classification: "assurance_gap",
            confidence: "C1",
            risk: "R2",
            maximumAction: "observe",
            message: `No statically linked test call covers exported '${node.qualifiedName}'`,
            evidence: ["repository graph found no incoming covers edge"],
            counterEvidence: [],
            unknown: ["dynamic tests, integration coverage, and external consumers may not be represented"],
          });
          if (finding) findings.push(finding);
        }
      }

      if (node.kind === "registration") {
        const registration = evidenceForNode(rootDir, node, `framework or runtime registration '${node.name}'`, "reference", node.metadata);
        if (registration) evidenceRecords.push(registration);
      }
    }

    for (const graphEdge of allEdges.filter((item) => item.kind === "imports" && reviewedFiles.includes(item.filePath))) {
      const target = store.node(graphEdge.toId);
      if (!target) continue;
      const fromLayer = layerFor(graphEdge.filePath, config);
      const toLayer = layerFor(target.filePath, config);
      if (!fromLayer || !toLayer || fromLayer === toLayer) continue;
      if (config.graph.allowedEdges.includes(`${fromLayer}->${toLayer}`)) continue;
      const sourceNode = store.nodes(graphEdge.filePath).find((item) => item.kind === "file");
      if (!sourceNode) continue;
      const finding = findingForNode(rootDir, sourceNode, {
        anchor: `architecture:${graphEdge.id}`,
        ruleId: "architecture.disallowed-dependency",
        classification: "context_conflict",
        confidence: "C2",
        risk: "R3",
        maximumAction: "observe",
        message: `${fromLayer} imports ${toLayer}, but '${fromLayer}->${toLayer}' is not allowed`,
        evidence: ["configured architecture layers and a resolved import edge conflict"],
        counterEvidence: [],
        unknown: ["an explicit architecture waiver may exist outside the configured graph policy"],
      });
      if (finding) findings.push(finding);
    }

    const afterSurface = store.publicSurface();
    const publicDelta = surfaceDelta(beforeSurface, afterSurface);
    evidenceRecords.push({
      schemaVersion: SCHEMA_VERSION,
      id: fingerprint("evidence", { provider: "repository-graph", publicDelta }),
      providerId: "repository-graph",
      providerVersion: "1",
      kind: "policy",
      summary: `public surface: ${publicDelta.added.length} added, ${publicDelta.changed.length} changed, ${publicDelta.removed.length} removed`,
      strength: "C2",
      details: publicDelta,
    });

    const statistics = store.statistics();
    evidenceRecords.push({
      schemaVersion: SCHEMA_VERSION,
      id: fingerprint("evidence", { provider: "repository-graph", statistics }),
      providerId: "repository-graph",
      providerVersion: "1",
      kind: "reference",
      summary: `repository graph contains ${statistics.files} file(s), ${statistics.nodes} node(s), and ${statistics.edges} edge(s)`,
      strength: "C2",
      details: statistics,
    });
    return createScanResult({
      engine: "provider-federation",
      engineVersion: "repository graph 1",
      rootDir,
      providerId: "repository-graph",
      providerVersion: "1",
      providerCapabilities: ["symbols", "references", "call-hierarchy", "public-surface", "tests"],
      evidenceRecords,
      scannedFiles: built.facts.map((facts) => facts.filePath),
      findings,
      skipped,
    });
  } finally {
    store.close();
  }
}

function nodeIdForFile(filePath: string): string {
  return fingerprint("graph-node", { filePath, kind: "file", qualifiedName: filePath });
}
