import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import type { AiSlopConfig } from "../core/config.ts";
import { createScanResult, fingerprint, normalizePath } from "../core/schema.ts";
import { offsetRange, safeProjectFile } from "../providers/files.ts";
import { SCHEMA_VERSION, type EvidenceRecord, type FindingDraft, type ScanResult, type ScanScope, type SkippedFile, type SourceRange } from "../types.ts";
import type { TypeScriptProjectContext } from "../typescript-scanner.ts";
import { buildGraphFacts } from "./build.ts";
import { GraphStore } from "./store.ts";
import type { GraphNode, PublicSurfaceEntry } from "./types.ts";

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


function rangeForNode(rootDir: string, node: GraphNode): SourceRange | undefined {
  const file = safeProjectFile(rootDir, node.filePath);
  return file ? offsetRange(node.filePath, file.source, node.start, node.end) : undefined;
}

function findingForNode(
  rootDir: string,
  node: GraphNode,
  values: Omit<FindingDraft, "filePath" | "line" | "column" | "start" | "end" | "sourceHash" | "anchor"> & { anchor: string },
): FindingDraft | undefined {
  const range = rangeForNode(rootDir, node);
  return range ? { ...range, ...values } : undefined;
}

function evidenceForNode(
  rootDir: string,
  node: GraphNode,
  summary: string,
  kind: EvidenceRecord["kind"],
  details: Record<string, unknown>,
): EvidenceRecord | undefined {
  const source = rangeForNode(rootDir, node);
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
  skipReason?: string,
): Promise<ScanResult> {
  if (!config.graph.enabled || skipReason) {
    const diagnostic = skipReason ?? "repository graph is disabled by configuration";
    return createScanResult({
      engine: "provider-federation",
      engineVersion: skipReason ? "repository graph memory bounded" : "repository graph disabled",
      rootDir,
      providerId: "repository-graph",
      providerVersion: "1",
      providerCapabilities: ["symbols", "references", "call-hierarchy", "public-surface", "tests"],
      providers: [{
        id: "repository-graph",
        version: "1",
        capabilities: ["symbols", "references", "call-hierarchy", "public-surface", "tests"],
        status: "skipped",
        diagnostic,
      }],
      scannedFiles: [],
      findings: [],
      skipped: [{ filePath: "<graph>", reason: diagnostic, providerId: "repository-graph" }],
    });
  }

  const store = new GraphStore(rootDir, stateRoot);
  const findings: FindingDraft[] = [];
  const evidenceRecords: EvidenceRecord[] = [];
  const skipped: SkippedFile[] = [];
  try {
    const root = realpathSync(rootDir);
    const graphCache = store.cachedFiles(paths);
    const requestedFiles = paths.map((filePath) => normalizePath(filePath.replace(/^@/, "")));
    const missingFiles = store.files().filter((filePath) => {
      const absolute = path.resolve(root, filePath);
      if (!existsSync(absolute)) return true;
      try {
        return !realpathSync(absolute).startsWith(`${root}${path.sep}`);
      } catch {
        return true;
      }
    });
    const beforeCandidates = store.publicSurface(new Set([...requestedFiles, ...missingFiles]));
    const changedFiles: string[] = [];
    const built = await buildGraphFacts(rootDir, paths, config, signal, reusableProjects, graphCache, (facts) => {
      store.updateFiles(facts);
      changedFiles.push(...facts.map((item) => item.filePath));
    });
    reusableProjects.length = 0;
    for (const [filePath, reason] of Object.entries(built.errors).sort(([left], [right]) => left.localeCompare(right))) {
      skipped.push({ filePath, reason, providerId: "repository-graph" });
    }
    const invalidFiles = Object.entries(built.errors)
      .filter(([, reason]) => !/^Python graph scan (?:unavailable|aborted):?/.test(reason))
      .map(([filePath]) => filePath);
    store.removeFiles([...new Set([...invalidFiles, ...missingFiles])]);
    const reviewedFiles = new Set([...changedFiles, ...built.cachedFiles].sort());
    const affectedFiles = new Set([...changedFiles, ...invalidFiles, ...missingFiles]);
    const beforeSurface = beforeCandidates.filter((entry) => affectedFiles.has(entry.filePath));
    const reportedCloneGroups = new Set<string>();
    reviewed: for (const page of store.nodePagesForFiles(reviewedFiles)) {
      for (const node of page) {
        if (findings.length >= config.limits.maxFindings) break reviewed;
        if (node.bodyHash && ["function", "class"].includes(node.kind) &&
          !/(?:^|\/)(?:tests?|alembic\/versions|migrations)(?:\/|$)/.test(node.filePath)) {
          const cloneGroup = `${node.kind}:${node.bodyHash}`;
          if (!reportedCloneGroups.has(cloneGroup)) {
            const clones = store.clones(node.bodyHash, node.kind, config.limits.maxFindings + 1).filter(
              (candidate) => !/(?:^|\/)(?:tests?|alembic\/versions|migrations)(?:\/|$)/.test(candidate.filePath),
            );
            const signature = node.signature?.slice(node.signature.indexOf("("));
            const compatibleSignatures = node.kind !== "function" || clones.every(
              (candidate) => candidate.signature?.slice(candidate.signature.indexOf("(")) === signature,
            );
            const simpleName = node.qualifiedName.split(".").at(-1);
            const sameLocalContract = clones.every((candidate) =>
              candidate.qualifiedName.split(".").at(-1) === simpleName &&
              (candidate.filePath === node.filePath || simpleName?.startsWith("_")));
            if (clones.length > 1 && !sameLocalContract && compatibleSignatures) {
              reportedCloneGroups.add(cloneGroup);
              const examples = clones
                .filter((candidate) => candidate.id !== node.id)
                .slice(0, 5)
                .map((item) => `${item.filePath}:${item.qualifiedName}`);
              const omitted = Math.max(0, clones.length - 1 - examples.length);
              const finding = findingForNode(rootDir, node, {
                anchor: `duplicate:${cloneGroup}`,
                ruleId: "structure.duplicate-capability",
                classification: "waste_candidate",
                confidence: "C1",
                risk: "R2",
                maximumAction: "observe",
                message: `'${node.qualifiedName}' has an exact normalized body match in ${clones.length - 1} other location(s): ${examples.join(", ")}${omitted ? ` (+${omitted} more)` : ""}`,
                evidence: ["repository graph found identical normalized function/class body hashes"],
                counterEvidence: [],
                unknown: ["duplicate bodies may intentionally implement separate contracts or boundaries"],
              });
              if (finding) findings.push(finding);
            }
          }
        }

      if (node.exported && ["function", "class", "variable"].includes(node.kind) && (evidenceRecords.length < config.limits.maxFindings || mode !== "repository")) {
        const callerEdges = store.incomingEdges(node.id, 101, "calls");
        const testEdges = store.incomingEdges(node.id, 101, "covers");
        const governingEdges = store.incomingEdges(nodeIdForFile(node.filePath), 101, "governs");
        const callers = callerEdges.slice(0, 100).flatMap((item) => store.node(item.fromId) ?? []);
        const tests = testEdges.slice(0, 100).flatMap((item) => store.node(item.fromId) ?? []);
        const specifications = governingEdges.slice(0, 100).flatMap((item) => store.node(item.fromId) ?? []);
        if (evidenceRecords.length < config.limits.maxFindings) {
          const impact = evidenceForNode(rootDir, node, `repository impact for exported '${node.qualifiedName}'`, "reference", {
            callers: callerEdges.slice(0, 100).map((item) => item.fromId),
            tests: testEdges.slice(0, 100).map((item) => item.fromId),
            governingSpecifications: governingEdges.slice(0, 100).map((item) => item.fromId),
            callerLocations: callers.map((item) => `${item.filePath}:${item.qualifiedName}`),
            testFiles: [...new Set(tests.map((item) => item.filePath))],
            specificationFiles: [...new Set(specifications.map((item) => item.filePath))],
            truncated: callerEdges.length > 100 || testEdges.length > 100 || governingEdges.length > 100,
          });
          if (impact) evidenceRecords.push(impact);
        }
        if (!testEdges.length && mode !== "repository") {
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

      if (node.kind === "registration" && evidenceRecords.length < config.limits.maxFindings) {
        const registration = evidenceForNode(rootDir, node, `framework or runtime registration '${node.name}'`, "reference", node.metadata);
        if (registration) evidenceRecords.push(registration);
      }
    }
      }

    if (config.graph.layers.length) {
      architecture: for (const filePath of reviewedFiles) {
        const sourceNode = store.nodes(filePath).find((item) => item.kind === "file");
        if (!sourceNode) continue;
        for (const page of store.edgePages(filePath)) {
          for (const graphEdge of page) {
            if (findings.length >= config.limits.maxFindings) break architecture;
            if (graphEdge.kind !== "imports") continue;
            const target = store.node(graphEdge.toId);
            if (!target) continue;
            const fromLayer = layerFor(graphEdge.filePath, config);
            const toLayer = layerFor(target.filePath, config);
            if (!fromLayer || !toLayer || fromLayer === toLayer) continue;
            if (config.graph.allowedEdges.includes(`${fromLayer}->${toLayer}`)) continue;
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
        }
      }
    }

    const afterSurface = store.publicSurface(affectedFiles);
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
      summary: `repository graph contains ${statistics.files} file(s), ${statistics.nodes} node(s), and ${statistics.edges} edge(s); ${built.cachedFiles.length} cache hit(s), ${built.facts.length} updated`,
      strength: "C2",
      details: { ...statistics, cacheHits: built.cachedFiles.length, updatedFiles: built.facts.length },
    });
    return createScanResult({
      engine: "provider-federation",
      engineVersion: "repository graph 1",
      rootDir,
      providerId: "repository-graph",
      providerVersion: "1",
      providerCapabilities: ["symbols", "references", "call-hierarchy", "public-surface", "tests"],
      evidenceRecords,
      scannedFiles: [...reviewedFiles],
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
