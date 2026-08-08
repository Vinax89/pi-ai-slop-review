import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { StateStore } from "./core/store.ts";
import { SCHEMA_VERSION, type FeedbackRecord, type Finding, type ScanResult, type Verdict, type VerdictRecord } from "./types.ts";

export interface VerdictEntry {
  findingId: string;
  verdict: Verdict;
  evidence: string;
}

export type VerdictClassification =
  | { status: "new" }
  | { status: "stale"; record: VerdictRecord }
  | { status: "same"; record: VerdictRecord };

export interface VerdictDelta {
  findings: Array<{ finding: Finding; classification: VerdictClassification }>;
  resolved: VerdictRecord[];
}

const VERDICTS = new Set<Verdict>(["confirmed", "dismissed", "needs-context"]);

/**
 * Append-or-replace adjudication verdicts in the review ledger. This is a
 * review-history log only: it never suppresses findings and never alters
 * policy decisions.
 */
export function recordVerdicts(rootDir: string, scan: ScanResult, entries: VerdictEntry[], stateRoot?: string): number {
  const store = new StateStore(rootDir, stateRoot);
  const byId = new Map(scan.findings.map((finding) => [finding.id, finding]));
  const now = new Date().toISOString();
  const records: VerdictRecord[] = [];
  for (const entry of entries) {
    if (!VERDICTS.has(entry.verdict)) throw new Error(`verdict must be confirmed, dismissed, or needs-context`);
    const finding = byId.get(entry.findingId);
    if (!finding) throw new Error(`verdict references finding '${entry.findingId}' which is not in the latest review`);
    const evidence = entry.evidence.trim();
    if (!evidence) throw new Error(`verdict for '${entry.findingId}' requires evidence`);
    records.push({
      schemaVersion: SCHEMA_VERSION,
      findingId: finding.id,
      ruleId: finding.ruleId,
      filePath: finding.filePath,
      line: finding.line,
      anchor: finding.anchor,
      sourceHash: finding.sourceHash,
      verdict: entry.verdict,
      evidence,
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
      if (existing && existing.sourceHash === record.sourceHash && existing.verdict === record.verdict && existing.evidence === record.evidence) continue;
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

export function classifyVerdicts(findings: Finding[], ledger: VerdictRecord[]): VerdictDelta {
  const byId = new Map(ledger.map((record) => [record.findingId, record]));
  const present = new Set<string>();
  const classified = findings.map((finding) => {
    present.add(finding.id);
    const record = byId.get(finding.id);
    const classification: VerdictClassification = !record
      ? { status: "new" }
      : record.sourceHash !== finding.sourceHash
        ? { status: "stale", record }
        : { status: "same", record };
    return { finding, classification };
  });
  return { findings: classified, resolved: ledger.filter((record) => !present.has(record.findingId)) };
}

export function verdictToFeedbackOutcome(verdict: Verdict): FeedbackRecord["outcome"] {
  if (verdict === "confirmed") return "accepted";
  if (verdict === "dismissed") return "intentional";
  return "insufficient-evidence";
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

export interface VerdictManifestEntry {
  findingId: string;
  ruleId: string;
  filePath: string;
  line: number;
  verdict: Verdict;
  evidence: string;
  status: "new" | "same" | "stale" | "resolved";
  reviewedAt: string;
}

export interface VerdictManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: string;
  scanId: string;
  scannedFiles: string[];
  candidates: number;
  adjudicated: VerdictManifestEntry[];
  resolved: number;
}

export function verdictManifest(scan: ScanResult, delta: VerdictDelta): VerdictManifest {
  const adjudicated = delta.findings.map(({ finding, classification }) => {
    const record = classification.status === "new" ? undefined : classification.record;
    return {
      findingId: finding.id,
      ruleId: finding.ruleId,
      filePath: finding.filePath,
      line: finding.line,
      verdict: record?.verdict ?? "needs-context",
      evidence: record?.evidence ?? "not yet adjudicated",
      status: classification.status,
      reviewedAt: record?.createdAt ?? "",
    } satisfies VerdictManifestEntry;
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scanId: scan.scanId,
    scannedFiles: [...scan.scannedFiles],
    candidates: scan.findings.length,
    adjudicated,
    resolved: delta.resolved.length,
  };
}

export function writeVerdictManifest(rootDir: string, scan: ScanResult, delta: VerdictDelta, exportPath: string): string {
  const absolute = path.resolve(rootDir, exportPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporaryPath = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(verdictManifest(scan, delta), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, absolute);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return absolute;
}
