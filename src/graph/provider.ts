import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import type { AiSlopConfig } from "../core/config.ts";
import { createScanResult, fingerprint } from "../core/schema.ts";
import { offsetRange, safeProjectFile } from "../providers/files.ts";
import { SCHEMA_VERSION, type EvidenceRecord, type FindingDraft, type ScanResult, type ScanScope, type SkippedFile, type SourceRange } from "../types.ts";
import type { TypeScriptProjectContext } from "../typescript-scanner.ts";
import { buildGraphFacts } from "./build.ts";
import { GraphStore } from "./store.ts";
import type { GraphEdge, GraphNode, PublicSurfaceEntry } from "./types.ts";

function matches(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => pathMatches(filePath, pattern));
}

function pathMatches(filePath: string, pattern: string): boolean {
  try {
    return path.matchesGlob(filePath, pattern);
  } catch {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
    return new RegExp(`^${escaped}$`).test(filePath);
  }
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

type SourceSnapshot = { source: string; sourceHash: string };

function rangeForNode(rootDir: string, node: GraphNode, sources: Map<string, SourceSnapshot>): SourceRange | undefined {
  const cached = sources.get(node.filePath);
  if (cached) return offsetRange(node.filePath, cached.source, node.start, node.end, cached.sourceHash);
  const file = safeProjectFile(rootDir, node.filePath);
  return file ? offsetRange(node.filePath, file.source, node.start, node.end) : undefined;
}

function findingForNode(
  rootDir: string,
  node: GraphNode,
  sources: Map<string, SourceSnapshot>,
  values: Omit<FindingDraft, "filePath" | "line" | "column" | "start" | "end" | "sourceHash" | "anchor"> & { anchor: string },
): FindingDraft | undefined {
  const range = rangeForNode(rootDir, node, sources);
  return range ? { ...range, ...values } : undefined;
}

function evidenceForNode(
  rootDir: string,
  node: GraphNode,
  sources: Map<string, SourceSnapshot>,
  summary: string,
  kind: EvidenceRecord["kind"],
  details: Record<string, unknown>,
): EvidenceRecord | undefined {
  const source = rangeForNode(rootDir, node, sources);
  if (!source) return undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: fingerprint("evidence", { nodeId: node.id, provider: "repository-graph", summary, details }),
    providerId: "repository-graph",
    providerVersion: "1",
    kind,
    summary,
    strength: "C2",
    source,
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
  reusableProjects: TypeScriptProjectContext[] = [],
): Promise<ScanResult> {
  if (!config.graph.enabled) {
    return createScanResult({
      engine: "provider-federation",
      engineVersion: "repository graph disabled",
      rootDir,
      providerId: "repository-graph",
      providerVersion: "1",
      providerCapabilities: ["symbols", "references", "call-hierarchy", "public-surface", "tests"],
      providers: [{
        id: "repository-graph",
        version: "1",
        capabilities: ["symbols", "references", "call-hierarchy", "public-surface", "tests"],
        status: "skipped",
        diagnostic: "disabled by configuration",
      }],
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
    const built = await buildGraphFacts(rootDir, paths, config, signal, reusableProjects);
    const sources = new Map(
      built.facts.flatMap((facts) => facts.source === undefined ? [] : [[facts.filePath, { source: facts.source, sourceHash: facts.sourceHash }] as const]),
    );
    for (const [filePath, reason] of Object.entries(built.errors)) skipped.push({ filePath, reason, providerId: "repository-graph" });
    const invalidFiles = Object.entries(built.errors)
      .filter(([, reason]) => !/^Python graph scan (?:unavailable|aborted):?/.test(reason))
      .map(([filePath]) => filePath);
    const root = realpathSync(rootDir);
    const missingFiles = store.files().filter((filePath) => {
      const absolute = path.resolve(root, filePath);
      if (!existsSync(absolute)) return true;
      try {
        return !realpathSync(absolute).startsWith(`${root}${path.sep}`);
      } catch {
        return true;
      }
    });
    store.removeFiles([...new Set([...invalidFiles, ...missingFiles])]);
    store.updateFiles(built.facts);
    const reviewedFiles = built.facts.map((facts) => facts.filePath);
    const reviewedFileSet = new Set(reviewedFiles);
    const reviewedNodes = built.facts.flatMap((facts) => facts.nodes);
    const reviewedNodeById = new Map(reviewedNodes.map((node) => [node.id, node]));
    const rootNodeByFile = new Map(reviewedNodes.filter((node) => node.kind === "file" || node.kind === "specification").map((node) => [node.filePath, node]));
    const allEdges = store.edges();
    const duplicateBodyGroups = store.duplicateBodyGroups();
    const incomingByTarget = new Map<string, GraphEdge[]>();
    for (const graphEdge of allEdges) {
      const incoming = incomingByTarget.get(graphEdge.toId);
      if (incoming) incoming.push(graphEdge);
      else incomingByTarget.set(graphEdge.toId, [graphEdge]);
    }

    const reportedCloneGroups = new Set<string>();
    for (const node of reviewedNodes) {
      if (findings.length >= config.limits.maxFindings) break;
      if (node.bodyHash && ["function", "class"].includes(node.kind)) {
        const cloneGroup = `${node.kind}:${node.bodyHash}`;
        if (duplicateBodyGroups.has(cloneGroup) && !reportedCloneGroups.has(cloneGroup)) {
          const clones = store.clones(node.bodyHash).filter((candidate) => candidate.id !== node.id && candidate.kind === node.kind);
          if (clones.length) {
            reportedCloneGroups.add(cloneGroup);
            const examples = clones.slice(0, 5).map((item) => `${item.filePath}:${item.qualifiedName}`);
            const omitted = clones.length - examples.length;
            const finding = findingForNode(rootDir, node, sources, {
              anchor: `duplicate:${cloneGroup}`,
              ruleId: "structure.duplicate-capability",
              classification: "waste_candidate",
              confidence: "C1",
              risk: "R2",
              maximumAction: "observe",
              message: `'${node.qualifiedName}' has an exact normalized body match in ${clones.length} other location(s): ${examples.join(", ")}${omitted ? ` (+${omitted} more)` : ""}`,
              evidence: ["repository graph found identical normalized function/class body hashes"],
              counterEvidence: [],
              unknown: ["duplicate bodies may intentionally implement separate contracts or boundaries"],
            });
            if (finding) findings.push(finding);
          }
        }
      }

      if (node.exported && ["function", "class", "variable"].includes(node.kind)) {
        const incoming = incomingByTarget.get(node.id) ?? [];
        const callers = incoming.filter((item) => item.kind === "calls");
        const tests = incoming.filter((item) => item.kind === "covers");
        const governing = (incomingByTarget.get(nodeIdForFile(node.filePath)) ?? []).filter((item) => item.kind === "governs");
        const impact = evidenceForNode(rootDir, node, sources, `repository impact for exported '${node.qualifiedName}'`, "reference", {
          callers: callers.map((item) => item.fromId),
          tests: tests.map((item) => item.fromId),
          governingSpecifications: governing.map((item) => item.fromId),
        });
        if (impact) evidenceRecords.push(impact);
        if (!tests.length && mode !== "repository") {
          const finding = findingForNode(rootDir, node, sources, {
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
        const registration = evidenceForNode(rootDir, node, sources, `framework or runtime registration '${node.name}'`, "reference", node.metadata);
        if (registration) evidenceRecords.push(registration);
      }
    }

    for (const graphEdge of allEdges.filter((item) => item.kind === "imports" && reviewedFileSet.has(item.filePath))) {
      if (findings.length >= config.limits.maxFindings) break;
      const target = reviewedNodeById.get(graphEdge.toId) ?? store.node(graphEdge.toId);
      if (!target) continue;
      const fromLayer = layerFor(graphEdge.filePath, config);
      const toLayer = layerFor(target.filePath, config);
      if (!fromLayer || !toLayer || fromLayer === toLayer) continue;
      if (config.graph.allowedEdges.includes(`${fromLayer}->${toLayer}`)) continue;
      const sourceNode = rootNodeByFile.get(graphEdge.filePath) ?? store.nodes(graphEdge.filePath).find((item) => item.kind === "file");
      if (!sourceNode) continue;
      const finding = findingForNode(rootDir, sourceNode, sources, {
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
