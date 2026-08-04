import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { assessScanCompleteness } from "./completeness.ts";
import { isInside, normalizePath } from "./paths.ts";
import {
  SCHEMA_VERSION,
  type EvidenceKind,
  type EvidenceRecord,
  type Finding,
  type FindingClass,
  type FindingConfidence,
  type FindingDraft,
  type FindingRisk,
  type MaximumAction,
  type PolicyDecision,
  type ProviderCapability,
  type ProviderRun,
  type RuleHealth,
  type ScanResult,
  type ScanScope,
  type SkippedFile,
} from "../types.ts";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function canonicalFilePath(rootDir: string, rawPath: string): string {
  let root: string;
  try {
    root = realpathSync(rootDir);
  } catch {
    root = path.resolve(rootDir);
  }
  const candidate = path.resolve(root, rawPath.replace(/^@/, ""));
  try {
    const resolved = realpathSync(candidate);
    if (isInside(root, resolved)) return normalizePath(path.relative(root, resolved));
  } catch {
    // Keep the lexical path for files that do not exist yet.
  }
  return normalizePath(path.relative(root, candidate));
}

function fileContentHash(rootDir: string, filePath: string, fallback?: string): string | null {
  let root: string;
  try {
    root = realpathSync(rootDir);
  } catch {
    root = path.resolve(rootDir);
  }
  const absolute = path.resolve(root, filePath);
  const relative = path.relative(root, absolute);
  if (relative !== "" && (relative.startsWith("..") || path.isAbsolute(relative))) return null;
  try {
    const resolved = realpathSync(absolute);
    if (!isInside(root, resolved)) return null;
    if (statSync(resolved).isFile()) return sha256(readFileSync(resolved));
  } catch {
    // A skipped or removed file has no current content hash.
  }
  return fallback ?? null;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function fingerprint(namespace: string, value: unknown): string {
  return `${namespace}:${sha256(canonicalJson(value)).slice(0, 24)}`;
}

export { normalizePath } from "./paths.ts";

function evidenceKind(ruleId: string): EvidenceKind {
  if (ruleId.startsWith("dependency.")) return "resolution";
  if (ruleId.startsWith("errors.") || ruleId.startsWith("data.")) return "control-flow";
  if (ruleId.startsWith("structure.")) return "reference";
  return "diagnostic";
}

export function createFinding(
  draft: FindingDraft,
  providerId: string,
  providerVersion: string,
): { finding: Finding; evidenceRecords: EvidenceRecord[] } {
  const source = {
    filePath: normalizePath(draft.filePath),
    line: draft.line,
    column: draft.column,
    start: draft.start,
    end: draft.end,
    sourceHash: draft.sourceHash,
  };
  const id = fingerprint("finding", {
    anchor: draft.anchor,
    filePath: source.filePath,
    ruleId: draft.ruleId,
  });
  const positive = draft.evidence.map((summary, index) => ({
    schemaVersion: SCHEMA_VERSION,
    id: fingerprint("evidence", { findingId: id, index, kind: "positive", providerId, summary }),
    providerId,
    providerVersion,
    kind: evidenceKind(draft.ruleId),
    summary,
    strength: draft.confidence,
    source,
  })) satisfies EvidenceRecord[];
  const counter = draft.counterEvidence.map((summary, index) => ({
    schemaVersion: SCHEMA_VERSION,
    id: fingerprint("evidence", { findingId: id, index, kind: "counter", providerId, summary }),
    providerId,
    providerVersion,
    kind: "counterevidence" as const,
    summary,
    strength: draft.confidence,
    source,
  })) satisfies EvidenceRecord[];
  return {
    finding: {
      ...draft,
      ...source,
      schemaVersion: SCHEMA_VERSION,
      id,
      evidenceIds: positive.map((item) => item.id),
      counterEvidenceIds: counter.map((item) => item.id),
    },
    evidenceRecords: [...positive, ...counter],
  };
}
export function scanIdFor(result: Omit<ScanResult, "scanId">): string {
  return fingerprint("scan", {
    engine: result.engine,
    engineVersion: result.engineVersion,
    scope: result.scope,
    providers: result.providers,
    evidenceRecords: result.evidenceRecords,
    scannedFiles: result.scannedFiles,
    findings: result.findings,
    suppressedFindings: result.suppressedFindings,
    policyDecisions: result.policyDecisions,
    ruleHealth: result.ruleHealth,
    skipped: result.skipped,
    completeness: result.completeness,
  });
}


export interface CreateScanResultInput {
  engine: ScanResult["engine"];
  engineVersion: string;
  mode?: ScanScope["mode"];
  rootDir: string;
  providers?: ProviderRun[];
  providerId: string;
  providerVersion: string;
  providerCapabilities?: ProviderCapability[];
  evidenceRecords?: EvidenceRecord[];
  scannedFiles: string[];
  findings: Array<Finding | FindingDraft>;
  skipped: SkippedFile[];
  generatedAt?: string;
}

function isFinalFinding(value: Finding | FindingDraft): value is Finding {
  return "schemaVersion" in value && "id" in value;
}

export function createScanResult(input: CreateScanResultInput): ScanResult {
  const findings: Finding[] = [];
  const evidenceRecords: EvidenceRecord[] = [...(input.evidenceRecords ?? [])];
  for (const candidate of input.findings) {
    const finalized = isFinalFinding(candidate)
      ? { finding: candidate, evidenceRecords: [] as EvidenceRecord[] }
      : createFinding(
          { ...candidate, filePath: canonicalFilePath(input.rootDir, candidate.filePath) },
          input.providerId,
          input.providerVersion,
        );
    findings.push({
      ...finalized.finding,
      filePath: canonicalFilePath(input.rootDir, finalized.finding.filePath),
    });
    evidenceRecords.push(
      ...finalized.evidenceRecords.map((record) => ({
        ...record,
        source: record.source
          ? { ...record.source, filePath: canonicalFilePath(input.rootDir, record.source.filePath) }
          : undefined,
      })),
    );
  }
  findings.sort(
    (left, right) =>
      left.filePath.localeCompare(right.filePath) || left.line - right.line || left.ruleId.localeCompare(right.ruleId),
  );
  const scannedFiles = [...new Set(input.scannedFiles.map((filePath) => canonicalFilePath(input.rootDir, filePath)))].sort();
  const findingHashes = new Map(findings.map((item) => [item.filePath, item.sourceHash]));
  const sourceHashes = Object.fromEntries(
    scannedFiles.map((filePath) => [filePath, fileContentHash(input.rootDir, filePath, findingHashes.get(filePath))]),
  );
  const rootHash = sha256(path.resolve(input.rootDir));
  const contentHash = sha256(canonicalJson({ scannedFiles, sourceHashes }));
  const providers = input.providers ?? [
    {
      id: input.providerId,
      version: input.providerVersion,
      capabilities: input.providerCapabilities ?? [],
      status: input.skipped.length && !scannedFiles.length ? "degraded" : "completed",
    },
  ];
  const skipped = input.skipped.map((item) => ({ ...item, filePath: normalizePath(item.filePath) }));
  const completeness = assessScanCompleteness({ scannedFiles, providers, skipped });
  const result: ScanResult = {
    schemaVersion: SCHEMA_VERSION,
    scanId: "",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    engine: input.engine,
    engineVersion: input.engineVersion,
    scope: {
      mode: input.mode ?? "explicit",
      rootHash,
      contentHash,
      paths: scannedFiles,
    },
    providers,
    evidenceRecords,
    scannedFiles,
    findings,
    suppressedFindings: [],
    policyDecisions: [],
    ruleHealth: [],
    skipped,
    completeness,
  };
  result.scanId = scanIdFor(result);
  return result;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function mergeFindings(results: ScanResult[], rootDir: string): Finding[] {
  const merged = new Map<string, Finding>();
  for (const finding of results.flatMap((result) => result.findings)) {
    const canonical = { ...finding, filePath: canonicalFilePath(rootDir, finding.filePath) };
    const previous = merged.get(canonical.id);
    if (!previous) {
      merged.set(canonical.id, canonical);
      continue;
    }
    merged.set(canonical.id, {
      ...previous,
      evidence: uniqueStrings([...previous.evidence, ...canonical.evidence]),
      evidenceIds: uniqueStrings([...previous.evidenceIds, ...canonical.evidenceIds]),
      counterEvidence: uniqueStrings([...previous.counterEvidence, ...canonical.counterEvidence]),
      counterEvidenceIds: uniqueStrings([...previous.counterEvidenceIds, ...canonical.counterEvidenceIds]),
      unknown: uniqueStrings([...previous.unknown, ...canonical.unknown]),
    });
  }
  return [...merged.values()].sort(
    (left, right) =>
      left.filePath.localeCompare(right.filePath) || left.line - right.line || left.ruleId.localeCompare(right.ruleId),
  );
}

export function mergeScanResults(rootDir: string, results: ScanResult[], mode: ScanScope["mode"] = "explicit"): ScanResult {
  const findings = mergeFindings(results, rootDir);
  const scannedFiles = uniqueStrings(results.flatMap((result) => result.scannedFiles.map((filePath) => canonicalFilePath(rootDir, filePath))));
  const findingHashes = new Map(findings.map((item) => [item.filePath, item.sourceHash]));
  const sourceHashes = Object.fromEntries(
    scannedFiles.map((filePath) => [filePath, fileContentHash(rootDir, filePath, findingHashes.get(filePath))]),
  );
  const contentHash = sha256(canonicalJson({ scannedFiles, sourceHashes }));
  const evidenceRecords = [...new Map(results.flatMap((result) => result.evidenceRecords).map((item) => [item.id, item])).values()];
  const providers = [
    ...new Map(
      results.flatMap((result) => result.providers).map((item) => [`${item.id}:${item.version}:${item.status}`, item]),
    ).values(),
  ];
  const skipped = results.flatMap((result) => result.skipped).map((item) => ({ ...item, filePath: normalizePath(item.filePath) }));
  const completeness = assessScanCompleteness({ scannedFiles, providers, skipped });
  const result: ScanResult = {
    schemaVersion: SCHEMA_VERSION,
    scanId: "",
    generatedAt: new Date().toISOString(),
    engine: "semantic-review",
    engineVersion: results
      .map((result) => `${result.engine === "typescript-semantic" ? "typescript" : result.engine === "python-ast" ? "python" : result.engine} ${result.engineVersion}`)
      .join("; "),
    scope: {
      mode,
      rootHash: sha256(path.resolve(rootDir)),
      contentHash,
      paths: scannedFiles,
    },
    providers,
    evidenceRecords,
    scannedFiles,
    findings,
    suppressedFindings: results.flatMap((result) => result.suppressedFindings),
    policyDecisions: results.flatMap((result) => result.policyDecisions),
    ruleHealth: results.flatMap((result) => result.ruleHealth),
    skipped,
    completeness,
  };
  result.scanId = scanIdFor(result);
  return result;
}


const FINDING_CLASSES = new Set<FindingClass>(["defect", "waste_candidate", "context_conflict", "assurance_gap", "review_externality"]);
const FINDING_CONFIDENCE = new Set<FindingConfidence>(["C1", "C2", "C3"]);
const FINDING_RISKS = new Set<FindingRisk>(["R1", "R2", "R3"]);
const MAXIMUM_ACTIONS = new Set<MaximumAction>(["ignore", "observe", "propose", "delegate-safe-fix"]);
const EVIDENCE_KINDS = new Set<EvidenceKind>(["diagnostic", "syntax", "type", "resolution", "reference", "control-flow", "data-flow", "test", "coverage", "provenance", "policy", "counterevidence", "unknown"]);
const PROVIDER_CAPABILITIES = new Set<ProviderCapability>(["syntax", "types", "resolution", "symbols", "references", "call-hierarchy", "control-flow", "data-flow", "diagnostics", "coverage", "dependencies", "public-surface", "tests"]);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const permitted = new Set(allowed);
  return Object.keys(value).every((key) => permitted.has(key));
}

function strings(value: unknown, unique = false): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") &&
    (!unique || new Set(value).size === value.length);
}

function dateTime(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function bounded(value: unknown, minimum: number, maximum?: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && (maximum === undefined || value <= maximum);
}

function sourceRange(value: unknown, exact = false): boolean {
  if (!record(value) || (exact && !keys(value, ["filePath", "line", "column", "start", "end", "sourceHash"]))) return false;
  return typeof value.filePath === "string" && Number.isSafeInteger(value.line) && (value.line as number) >= 1 &&
    Number.isSafeInteger(value.column) && (value.column as number) >= 1 &&
    Number.isSafeInteger(value.start) && (value.start as number) >= 0 &&
    Number.isSafeInteger(value.end) && (value.end as number) >= (value.start as number) &&
    typeof value.sourceHash === "string";
}

function providerRun(value: unknown): value is ProviderRun {
  if (!record(value) || !keys(value, ["id", "version", "capabilities", "status", "durationMs", "diagnostic"])) return false;
  return typeof value.id === "string" && typeof value.version === "string" && strings(value.capabilities) &&
    value.capabilities.every((item) => PROVIDER_CAPABILITIES.has(item as ProviderCapability)) &&
    ["completed", "degraded", "failed", "skipped"].includes(String(value.status)) &&
    (value.durationMs === undefined || bounded(value.durationMs, 0)) &&
    (value.diagnostic === undefined || typeof value.diagnostic === "string");
}

function evidenceRecord(value: unknown): value is EvidenceRecord {
  if (!record(value) || !keys(value, ["schemaVersion", "id", "providerId", "providerVersion", "kind", "summary", "strength", "source", "details"])) return false;
  return value.schemaVersion === SCHEMA_VERSION && typeof value.id === "string" && typeof value.providerId === "string" &&
    typeof value.providerVersion === "string" && typeof value.kind === "string" && EVIDENCE_KINDS.has(value.kind as EvidenceKind) &&
    typeof value.summary === "string" && typeof value.strength === "string" && FINDING_CONFIDENCE.has(value.strength as FindingConfidence) &&
    (value.source === undefined || sourceRange(value.source, true)) && (value.details === undefined || record(value.details));
}

function finding(value: unknown): value is Finding {
  if (!record(value) || !keys(value, [
    "filePath", "line", "column", "start", "end", "sourceHash", "schemaVersion", "id", "anchor", "ruleId",
    "classification", "confidence", "risk", "maximumAction", "message", "evidence", "evidenceIds",
    "counterEvidence", "counterEvidenceIds", "unknown",
  ])) return false;
  return value.schemaVersion === SCHEMA_VERSION && typeof value.id === "string" && typeof value.anchor === "string" &&
    typeof value.ruleId === "string" && typeof value.classification === "string" && FINDING_CLASSES.has(value.classification as FindingClass) &&
    typeof value.confidence === "string" && FINDING_CONFIDENCE.has(value.confidence as FindingConfidence) &&
    typeof value.risk === "string" && FINDING_RISKS.has(value.risk as FindingRisk) &&
    typeof value.maximumAction === "string" && MAXIMUM_ACTIONS.has(value.maximumAction as MaximumAction) &&
    typeof value.message === "string" && strings(value.evidence) && strings(value.evidenceIds) &&
    strings(value.counterEvidence) && strings(value.counterEvidenceIds) && strings(value.unknown) && sourceRange(value);
}

function policyDecision(value: unknown): value is PolicyDecision {
  if (!record(value) || !keys(value, ["findingId", "originalConfidence", "finalConfidence", "originalAction", "finalAction", "evidenceScore", "reasons"])) return false;
  return typeof value.findingId === "string" && typeof value.originalConfidence === "string" &&
    FINDING_CONFIDENCE.has(value.originalConfidence as FindingConfidence) && typeof value.finalConfidence === "string" &&
    FINDING_CONFIDENCE.has(value.finalConfidence as FindingConfidence) && typeof value.originalAction === "string" &&
    MAXIMUM_ACTIONS.has(value.originalAction as MaximumAction) && typeof value.finalAction === "string" &&
    MAXIMUM_ACTIONS.has(value.finalAction as MaximumAction) && bounded(value.evidenceScore, 0, 1) && strings(value.reasons);
}

function ruleHealth(value: unknown): value is RuleHealth {
  if (!record(value) || !keys(value, [
    "ruleId", "samples", "accepted", "rejected", "unsafeActions", "precision", "wilsonLowerBound",
    "selectiveThreshold", "conformalThreshold", "status",
  ])) return false;
  const count = (item: unknown): boolean => Number.isSafeInteger(item) && (item as number) >= 0;
  const probability = (item: unknown): boolean => item === null || bounded(item, 0, 1);
  return typeof value.ruleId === "string" && count(value.samples) && count(value.accepted) &&
    count(value.rejected) && count(value.unsafeActions) && probability(value.precision) &&
    probability(value.wilsonLowerBound) && probability(value.selectiveThreshold) &&
    probability(value.conformalThreshold) && ["insufficient-data", "healthy", "observe-only", "disabled"].includes(String(value.status));
}

function skippedFile(value: unknown): value is SkippedFile {
  return record(value) && keys(value, ["filePath", "reason", "providerId"]) &&
    typeof value.filePath === "string" && typeof value.reason === "string" &&
    (value.providerId === undefined || typeof value.providerId === "string");
}

function scanCompleteness(value: unknown): boolean {
  return record(value) && keys(value, ["status", "scannedFiles", "skippedItems", "reasons"]) &&
    ["complete", "partial", "abstained"].includes(String(value.status)) &&
    Number.isSafeInteger(value.scannedFiles) && (value.scannedFiles as number) >= 0 &&
    Number.isSafeInteger(value.skippedItems) && (value.skippedItems as number) >= 0 && strings(value.reasons);
}

export function isScanResult(value: unknown): value is ScanResult {
  if (!record(value) || !keys(value, [
    "schemaVersion", "scanId", "generatedAt", "engine", "engineVersion", "scope", "providers", "evidenceRecords",
    "scannedFiles", "findings", "suppressedFindings", "policyDecisions", "ruleHealth", "skipped", "completeness",
  ])) return false;
  if (
    value.schemaVersion !== SCHEMA_VERSION || typeof value.scanId !== "string" || !/^scan:/.test(value.scanId) ||
    !dateTime(value.generatedAt) ||
    !["typescript-semantic", "python-ast", "semantic-review", "provider-federation"].includes(String(value.engine)) ||
    typeof value.engineVersion !== "string" || !record(value.scope) || !Array.isArray(value.providers) ||
    !Array.isArray(value.evidenceRecords) || !strings(value.scannedFiles, true) || !Array.isArray(value.findings) ||
    !Array.isArray(value.suppressedFindings) || !Array.isArray(value.policyDecisions) || !Array.isArray(value.ruleHealth) ||
    !Array.isArray(value.skipped) || (value.completeness !== undefined && !scanCompleteness(value.completeness))
  ) return false;
  const scope = value.scope;
  if (!keys(scope, ["mode", "rootHash", "contentHash", "paths", "baselineId"])) return false;
  return ["session", "explicit", "delta", "repository"].includes(String(scope.mode)) && typeof scope.rootHash === "string" &&
    typeof scope.contentHash === "string" && strings(scope.paths, true) && (scope.baselineId === undefined || typeof scope.baselineId === "string") &&
    value.providers.every(providerRun) && value.evidenceRecords.every(evidenceRecord) && value.findings.every(finding) &&
    value.suppressedFindings.every(finding) && value.policyDecisions.every(policyDecision) && value.ruleHealth.every(ruleHealth) &&
    value.skipped.every(skippedFile);
}
