import { closeSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { StateStore } from "./core/store.ts";
import { fingerprint } from "./core/schema.ts";
import { assessScanCompleteness } from "./core/completeness.ts";
import { isInside, nearestExistingParent } from "./core/paths.ts";
import { queryContext } from "./graph/query.ts";
import { SCHEMA_VERSION, type FeedbackRecord, type Finding, type ScanResult, type Verdict, type VerdictRecord } from "./types.ts";

export interface VerdictEntry {
  findingId: string;
  verdict: Verdict;
  evidence?: string;
  evidenceIds?: string[];
  rationale?: string;
}

export type VerdictClassification =
  | { status: "new" }
  | { status: "context-changed"; record: VerdictRecord }
  | { status: "reusable"; record: VerdictRecord };

export interface VerdictDelta {
  findings: Array<{ finding: Finding; classification: VerdictClassification }>;
  resolved: VerdictRecord[];
  notObserved: VerdictRecord[];
}

const VERDICTS = new Set<Verdict>(["confirmed", "dismissed", "needs-context"]);
const MAX_VERDICT_BATCH = 20;
const MAX_EVIDENCE_IDS = 50;
const MAX_RATIONALE_LENGTH = 2_000;
type FingerprintContext = ReturnType<typeof queryContext> & { unavailable?: true };

function normalizedRationale(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function renderedRationale(value: string): string {
  const normalized = normalizedRationale(value);
  return normalized.length <= MAX_RATIONALE_LENGTH ? normalized : `${normalized.slice(0, MAX_RATIONALE_LENGTH - 1)}…`;
}

/** Hash every deterministic input available to adjudication. The scan content
 * hash deliberately invalidates conservatively when callers, tests, exports,
 * specifications, config, or other scanned repository context changes. */
export function adjudicationContextFingerprint(
  rootDir: string,
  scan: ScanResult,
  finding: Finding,
  contextCache = new Map<string, FingerprintContext>(),
): string {
  const linked = new Set([...finding.evidenceIds, ...finding.counterEvidenceIds]);
  const evidence = scan.evidenceRecords.filter((record) =>
    linked.has(record.id) || record.source?.filePath === finding.filePath,
  );
  const graphContext = [finding.anchor, finding.filePath].map((query) => {
    const cached = contextCache.get(query);
    if (cached) return cached;
    try {
      const context = queryContext(rootDir, query);
      contextCache.set(query, context);
      return context;
    } catch {
      const context: FingerprintContext = { query, nodes: [], impacts: [], publicSurface: [], unavailable: true };
      contextCache.set(query, context);
      return context;
    }
  });
  return fingerprint("adjudication-context", {
    finding: {
      id: finding.id, sourceHash: finding.sourceHash, anchor: finding.anchor,
      evidence: finding.evidence, counterEvidence: finding.counterEvidence, unknown: finding.unknown,
    },
    repositoryContextHash: scan.scope.contentHash,
    scope: scan.scope,
    providers: scan.providers,
    evidence,
    graphContext,
    completeness: scan.completeness ?? assessScanCompleteness(scan),
  });
}

/**
 * Append-or-replace adjudication verdicts in the review ledger. This is a
 * review-history log only: it never suppresses findings and never alters
 * policy decisions.
 */
export function recordVerdicts(rootDir: string, scan: ScanResult, entries: VerdictEntry[], stateRoot?: string): number {
  if (!Array.isArray(entries)) throw new Error("verdict entries must be an array");
  if (entries.length < 1 || entries.length > MAX_VERDICT_BATCH) throw new Error(`verdict batch must contain 1 to ${MAX_VERDICT_BATCH} entries`);
  if (entries.some((entry) => !entry || typeof entry !== "object" || typeof entry.findingId !== "string" || !entry.findingId || entry.findingId.length > 200)) {
    throw new Error("verdict findingId must be a non-empty string of at most 200 characters");
  }
  const submittedIds = entries.map((entry) => entry.findingId);
  if (new Set(submittedIds).size !== submittedIds.length) throw new Error("verdict batch contains duplicate finding IDs");
  const store = new StateStore(rootDir, stateRoot);
  const byId = new Map(scan.findings.map((finding) => [finding.id, finding]));
  const now = new Date().toISOString();
  const records: VerdictRecord[] = [];
  const contextCache = new Map<string, FingerprintContext>();
  for (const entry of entries) {
    if (!VERDICTS.has(entry.verdict)) throw new Error(`verdict must be confirmed, dismissed, or needs-context`);
    const finding = byId.get(entry.findingId);
    if (!finding) throw new Error(`verdict references finding '${entry.findingId}' which is not in the latest review`);
    if (entry.evidenceIds !== undefined && (!Array.isArray(entry.evidenceIds) || entry.evidenceIds.length > MAX_EVIDENCE_IDS)) {
      throw new Error(`verdict for '${entry.findingId}' exceeds ${MAX_EVIDENCE_IDS} evidence IDs`);
    }
    const evidenceIds = [...new Set(entry.evidenceIds ?? [])];
    if (evidenceIds.some((evidenceId) => typeof evidenceId !== "string" || evidenceId.length > 200)) {
      throw new Error(`verdict for '${entry.findingId}' contains an invalid evidence ID`);
    }
    const knownEvidenceIds = new Set([...finding.evidenceIds, ...finding.counterEvidenceIds]);
    for (const evidenceId of evidenceIds) {
      if (!knownEvidenceIds.has(evidenceId)) throw new Error(`verdict for '${entry.findingId}' references unknown evidence '${evidenceId}'`);
    }
    const rawEvidence = entry.rationale ?? entry.evidence ?? "";
    if (typeof rawEvidence !== "string" || rawEvidence.length > MAX_RATIONALE_LENGTH) {
      throw new Error(`verdict for '${entry.findingId}' rationale exceeds ${MAX_RATIONALE_LENGTH} characters`);
    }
    const evidence = normalizedRationale(rawEvidence);
    if (!evidence) throw new Error(`verdict for '${entry.findingId}' requires evidence`);
    records.push({
      schemaVersion: SCHEMA_VERSION,
      findingId: finding.id,
      ruleId: finding.ruleId,
      filePath: finding.filePath,
      line: finding.line,
      anchor: finding.anchor,
      sourceHash: finding.sourceHash,
      adjudicationContextFingerprint: adjudicationContextFingerprint(rootDir, scan, finding, contextCache),
      scanScope: { mode: scan.scope.mode, contentHash: scan.scope.contentHash, paths: [...scan.scope.paths] },
      verdict: entry.verdict,
      evidence,
      evidenceIds,
      scanId: scan.scanId,
      createdAt: now,
      repositoryId: store.repositoryId,
    });
  }
  let written = 0;
  store.update((state) => {
    const byFindingId = new Map(state.verdicts.map((record) => [record.findingId, record]));
    for (const record of records) {
      const existing = byFindingId.get(record.findingId);
      if (existing && existing.scanId === record.scanId && existing.adjudicationContextFingerprint === record.adjudicationContextFingerprint && existing.verdict === record.verdict && existing.evidence === record.evidence) continue;
      byFindingId.set(record.findingId, record);
      written += 1;
    }
    state.verdicts = [...byFindingId.values()];
  });
  return written;
}

export function verdictLedger(rootDir: string, stateRoot?: string): VerdictRecord[] {
  return new StateStore(rootDir, stateRoot).load().verdicts;
}

export function classifyVerdicts(rootDir: string, scan: ScanResult, ledger: VerdictRecord[]): VerdictDelta {
  const findings = scan.findings;
  const byId = new Map(ledger.map((record) => [record.findingId, record]));
  const contextCache = new Map<string, FingerprintContext>();
  const present = new Set<string>();
  const classified = findings.map((finding) => {
    present.add(finding.id);
    const record = byId.get(finding.id);
    const classification: VerdictClassification = !record
      ? { status: "new" }
      : record.adjudicationContextFingerprint !== adjudicationContextFingerprint(rootDir, scan, finding, contextCache)
        ? { status: "context-changed", record }
        : { status: "reusable", record };
    return { finding, classification };
  });
  const absent = ledger.filter((record) => !present.has(record.findingId));
  const complete = scan.completeness ?? assessScanCompleteness(scan);
  const equivalentFullRescan = scan.scope.mode === "repository" && complete.status === "complete";
  return {
    findings: classified,
    resolved: equivalentFullRescan ? absent : [],
    notObserved: equivalentFullRescan ? [] : absent,
  };
}

export function verdictToFeedbackOutcome(verdict: Verdict): FeedbackRecord["outcome"] {
  if (verdict === "confirmed") return "accepted";
  if (verdict === "dismissed") return "intentional";
  return "insufficient-evidence";
}

export function formatVerdictDelta(delta: VerdictDelta, prefix?: string): string {
  const selected = prefix
    ? delta.findings.filter((item) => item.finding.id === prefix || item.finding.id.startsWith(prefix))
    : delta.findings;
  const resolved = prefix ? delta.resolved.filter((record) => record.findingId === prefix || record.findingId.startsWith(prefix)) : delta.resolved;
  const counts = { new: 0, reusable: 0, "context-changed": 0 };
  const lines = ["REVIEW VERDICT LEDGER"];
  for (const { finding, classification } of selected) {
    if (classification.status === "new") {
      counts.new += 1;
      lines.push(`- ${finding.id} | ${finding.ruleId} | ${finding.filePath}:${finding.line} — NEW (no prior verdict)`);
    } else {
      const label = classification.status;
      counts[label] += 1;
      lines.push(`- ${finding.id} | ${finding.ruleId} | ${finding.filePath}:${finding.line} — ${label}: ${classification.record.verdict} (${classification.record.createdAt.slice(0, 10)})${classification.status === "context-changed" ? " — source or adjudication context changed" : ""}\n  ${renderedRationale(classification.record.evidence)}`);
    }
  }
  lines.push(`Ledger: ${counts.new} new, ${counts.reusable} reusable, ${counts["context-changed"]} context-changed${resolved.length ? `, ${resolved.length} resolved` : ""}${delta.notObserved.length ? `, ${delta.notObserved.length} not-observed/out-of-scope` : ""}`);
  if (prefix && selected.length !== delta.findings.length) lines.push(`Use an exact finding ID for full details; ${delta.findings.length - selected.length} other finding(s) omitted.`);
  return lines.join("\n");
}

export interface VerdictStats {
  ruleId: string;
  total: number;
  confirmed: number;
  dismissed: number;
  needsContext: number;
}

export function verdictStats(ledger: VerdictRecord[]): VerdictStats[] {
  const groups = new Map<string, VerdictStats>();
  for (const record of ledger) {
    const entry = groups.get(record.ruleId) ?? { ruleId: record.ruleId, total: 0, confirmed: 0, dismissed: 0, needsContext: 0 };
    entry.total += 1;
    if (record.verdict === "confirmed") entry.confirmed += 1;
    else if (record.verdict === "dismissed") entry.dismissed += 1;
    else entry.needsContext += 1;
    groups.set(record.ruleId, entry);
  }
  return [...groups.values()].sort((left, right) => right.total - left.total);
}

/**
 * Advisory report-only candidates: rule families with enough stored verdicts
 * and a high dismissal rate. Pure signal — the caller decides whether to
 * apply it to `rules.reportOnly`.
 */
export function suggestReportOnlyRules(stats: VerdictStats[], minimumReviews = 5, dismissalRate = 0.75): string[] {
  return stats
    .filter((item) => item.total >= minimumReviews && item.dismissed / item.total >= dismissalRate)
    .map((item) => item.ruleId);
}

export interface VerdictManifestEntry {
  findingId: string;
  ruleId: string;
  filePath: string;
  line: number;
  verdict: Verdict;
  evidence: string;
  status: "reusable" | "context-changed";
  reviewedAt: string;
}

export interface VerdictManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: string;
  scanId: string;
  scannedFiles: string[];
  candidates: number;
  adjudicated: VerdictManifestEntry[];
  unreviewed: Array<{ findingId: string; ruleId: string; filePath: string; line: number; status: "new" | "context-changed" }>;
  resolved: number;
  notObserved: number;
}

export function verdictManifest(scan: ScanResult, delta: VerdictDelta): VerdictManifest {
  const adjudicated = delta.findings.flatMap(({ finding, classification }) => {
    if (classification.status !== "reusable") return [];
    const record = classification.record;
    return [{
      findingId: finding.id,
      ruleId: finding.ruleId,
      filePath: finding.filePath,
      line: finding.line,
      verdict: record.verdict,
      evidence: renderedRationale(record.evidence),
      status: classification.status,
      reviewedAt: record.createdAt,
    } satisfies VerdictManifestEntry];
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scanId: scan.scanId,
    scannedFiles: [...scan.scannedFiles],
    candidates: scan.findings.length,
    adjudicated,
    unreviewed: delta.findings.filter((item) => item.classification.status !== "reusable").map(({ finding, classification }) => ({
      findingId: finding.id, ruleId: finding.ruleId, filePath: finding.filePath, line: finding.line,
      status: classification.status as "new" | "context-changed",
    })),
    resolved: delta.resolved.length,
    notObserved: delta.notObserved.length,
  };
}

export function writeVerdictManifest(rootDir: string, scan: ScanResult, delta: VerdictDelta, exportPath: string): string {
  const root = realpathSync(rootDir);
  const absolute = path.resolve(root, exportPath);
  if (!isInside(root, absolute) || !isInside(root, realpathSync(nearestExistingParent(absolute)))) {
    throw new Error("verdict manifest path resolves outside the project root");
  }
  mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
  const temporaryPath = `${absolute}.${process.pid}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(verdictManifest(scan, delta), null, 2)}\n`, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, absolute);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
  return absolute;
}
