import { createHash } from "node:crypto";
import path from "node:path";

import { assessScanCompleteness } from "./completeness.ts";
import { normalizePath } from "./paths.ts";
import {
  SCHEMA_VERSION,
  type EvidenceKind,
  type EvidenceRecord,
  type Finding,
  type FindingDraft,
  type ProviderCapability,
  type ProviderRun,
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
    if (isFinalFinding(candidate)) {
      findings.push(candidate);
      continue;
    }
    const finalized = createFinding(candidate, input.providerId, input.providerVersion);
    findings.push(finalized.finding);
    evidenceRecords.push(...finalized.evidenceRecords);
  }
  findings.sort(
    (left, right) =>
      left.filePath.localeCompare(right.filePath) || left.line - right.line || left.ruleId.localeCompare(right.ruleId),
  );
  const scannedFiles = [...new Set(input.scannedFiles.map(normalizePath))].sort();
  const sourceHashes = Object.fromEntries(
    [...new Set(findings.map((item) => [item.filePath, item.sourceHash] as const))].sort(([left], [right]) => left.localeCompare(right)),
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
  const scanId = fingerprint("scan", {
    contentHash,
    engine: input.engine,
    findings: findings.map((item) => item.id),
    providers,
    skipped,
    completeness,
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    scanId,
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
}

export function mergeScanResults(rootDir: string, results: ScanResult[], mode: ScanScope["mode"] = "explicit"): ScanResult {
  const findings = results.flatMap((result) => result.findings).sort(
    (left, right) =>
      left.filePath.localeCompare(right.filePath) || left.line - right.line || left.ruleId.localeCompare(right.ruleId),
  );
  const scannedFiles = [...new Set(results.flatMap((result) => result.scannedFiles))].sort();
  const evidenceRecords = [...new Map(results.flatMap((result) => result.evidenceRecords).map((item) => [item.id, item])).values()];
  const providers = [
    ...new Map(
      results.flatMap((result) => result.providers).map((item) => [`${item.id}:${item.version}:${item.status}`, item]),
    ).values(),
  ];
  const contentHash = sha256(canonicalJson(results.map((result) => result.scope.contentHash).sort()));
  const skipped = results.flatMap((result) => result.skipped);
  const completeness = assessScanCompleteness({ scannedFiles, providers, skipped });
  return {
    schemaVersion: SCHEMA_VERSION,
    scanId: fingerprint("scan", { contentHash, findings: findings.map((item) => item.id), providers, skipped, completeness }),
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
}

export function isScanResult(value: unknown): value is ScanResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ScanResult>;
  return (
    candidate.schemaVersion === SCHEMA_VERSION &&
    typeof candidate.scanId === "string" &&
    typeof candidate.generatedAt === "string" &&
    Array.isArray(candidate.providers) &&
    Array.isArray(candidate.evidenceRecords) &&
    Array.isArray(candidate.scannedFiles) &&
    Array.isArray(candidate.findings) &&
    Array.isArray(candidate.suppressedFindings) &&
    Array.isArray(candidate.policyDecisions) &&
    Array.isArray(candidate.ruleHealth) &&
    Array.isArray(candidate.skipped) &&
    (candidate.completeness === undefined || ["complete", "partial", "abstained"].includes(candidate.completeness.status))
  );
}
