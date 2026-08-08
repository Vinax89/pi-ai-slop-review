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
  store.update((state) => {
    const byFindingId = new Map(state.verdicts.map((record) => [record.findingId, record]));
    for (const record of records) byFindingId.set(record.findingId, record);
    state.verdicts = [...byFindingId.values()];
  });
  return records.length;
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
