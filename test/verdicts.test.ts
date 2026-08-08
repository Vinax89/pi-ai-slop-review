import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createScanResult } from "../src/core/schema.ts";
import { createFindingQueue, parseVerdictLines, verifyVerdicts } from "../src/report.ts";
import { classifyVerdicts, recordVerdicts, verdictLedger, verdictManifest, verdictStats, verdictToFeedbackOutcome, writeVerdictManifest } from "../src/verdicts.ts";
import { readFileSync } from "node:fs";
import type { FindingDraft } from "../src/types.ts";

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-verdicts-"));
  writeFileSync(path.join(root, "input.ts"), "const value = 1;\n");
  return root;
}

function draft(overrides: Partial<FindingDraft> = {}): FindingDraft {
  return {
    anchor: "value",
    ruleId: "test.rule",
    classification: "context_conflict",
    confidence: "C2",
    risk: "R2",
    maximumAction: "observe",
    filePath: "input.ts",
    line: 1,
    column: 1,
    start: 0,
    end: 5,
    sourceHash: "hash-v1",
    message: "Example finding",
    evidence: ["test evidence"],
    counterEvidence: [],
    unknown: [],
    ...overrides,
  };
}

function resultWith(root: string, findings: FindingDraft[]) {
  return createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings,
    skipped: [],
  });
}

test("verdict line parser accepts the contract and reports structural violations", () => {
  const parsed = parseVerdictLines([
    "finding:abc123 | test.rule | input.ts:1 — evidence text",
    "finding:def456 | other.rule | input.ts:2:5 — with column",
  ]);
  assert.equal(parsed.violations.length, 0);
  assert.deepEqual(parsed.verdicts.map((item) => item.findingId), ["finding:abc123", "finding:def456"]);
  assert.equal(parsed.verdicts[1].line, 2);

  const broken = parseVerdictLines([
    "finding:abc123 | test.rule | input.ts:1 — first",
    "finding:abc123 | test.rule | input.ts:1 — duplicate",
    "not a verdict line",
  ]);
  assert.equal(broken.violations.length, 2);
  assert.match(broken.violations[0], /duplicate verdict/);
  assert.match(broken.violations[1], /unparseable verdict line/);
  assert.equal(broken.verdicts.length, 2);
});

test("verdict verification catches unknown IDs, mismatches, and count drift", () => {
  const root = fixture();
  const result = resultWith(root, [draft()]);
  const id = result.findings[0].id;

  const good = verifyVerdicts([`${id} | test.rule | input.ts:1 — ok`], result, 1);
  assert.equal(good.valid, true);
  assert.equal(good.violations.length, 0);

  const ruleMismatch = verifyVerdicts([`${id} | other.rule | input.ts:1 — mismatch`], result, 1);
  assert.equal(ruleMismatch.valid, false);
  assert.match(ruleMismatch.violations[0], /rule ID mismatch/);

  const locationMismatch = verifyVerdicts([`${id} | test.rule | input.ts:9 — mismatch`], result, 1);
  assert.equal(locationMismatch.valid, false);
  assert.match(locationMismatch.violations[0], /location mismatch/);

  const unknown = verifyVerdicts(["finding:deadbeef | test.rule | input.ts:1 — not in review"], result, 1);
  assert.equal(unknown.valid, false);
  assert.match(unknown.violations[0], /not in the latest review/);

  const drift = verifyVerdicts([], result, 2);
  assert.equal(drift.valid, false);
  assert.match(drift.violations[0], /verdict count 0 does not match adjudicated total 2/);
});

test("verdict ledger records, classifies new/same/stale, and resolves missing findings", () => {
  const root = fixture();
  const stateRoot = path.join(root, "state");
  const result = resultWith(root, [draft()]);
  const finding = result.findings[0];

  const count = recordVerdicts(root, result, [{ findingId: finding.id, verdict: "confirmed", evidence: "redundant private wrapper with no behavior" }], stateRoot);
  assert.equal(count, 1);
  const ledger = verdictLedger(root, stateRoot);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].verdict, "confirmed");
  assert.equal(ledger[0].findingId, finding.id);

  let delta = classifyVerdicts(result.findings, verdictLedger(root, stateRoot));
  assert.equal(delta.findings[0].classification.status, "same");
  assert.equal(delta.resolved.length, 0);

  const changed = resultWith(root, [draft({ sourceHash: "hash-v2" })]);
  delta = classifyVerdicts(changed.findings, verdictLedger(root, stateRoot));
  assert.equal(delta.findings[0].classification.status, "stale");

  const empty = resultWith(root, []);
  delta = classifyVerdicts(empty.findings, verdictLedger(root, stateRoot));
  assert.equal(delta.findings.length, 0);
  assert.equal(delta.resolved.length, 1);
});

test("verdict recording replaces prior verdicts per finding and rejects bad input", () => {
  const root = fixture();
  const stateRoot = path.join(root, "state");
  const result = resultWith(root, [draft()]);
  const finding = result.findings[0];

  recordVerdicts(root, result, [{ findingId: finding.id, verdict: "needs-context", evidence: "first pass" }], stateRoot);
  recordVerdicts(root, result, [{ findingId: finding.id, verdict: "dismissed", evidence: "exported compatibility API" }], stateRoot);
  assert.equal(verdictLedger(root, stateRoot).length, 1);
  assert.equal(verdictLedger(root, stateRoot)[0].verdict, "dismissed");

  assert.throws(
    () => recordVerdicts(root, result, [{ findingId: "finding:nope", verdict: "confirmed", evidence: "x" }], stateRoot),
    /not in the latest review/,
  );
  assert.throws(
    () => recordVerdicts(root, result, [{ findingId: finding.id, verdict: "maybe" as never, evidence: "x" }], stateRoot),
    /must be confirmed, dismissed, or needs-context/,
  );
  assert.throws(
    () => recordVerdicts(root, result, [{ findingId: finding.id, verdict: "confirmed", evidence: "  " }], stateRoot),
    /requires evidence/,
  );
});

test("verdict outcomes map to conservative feedback outcomes", () => {
  assert.equal(verdictToFeedbackOutcome("confirmed"), "accepted");
  assert.equal(verdictToFeedbackOutcome("dismissed"), "intentional");
  assert.equal(verdictToFeedbackOutcome("needs-context"), "insufficient-evidence");
});

test("identical verdict re-records are skipped and keep their original timestamp", () => {
  const root = fixture();
  const stateRoot = path.join(root, "state");
  const result = resultWith(root, [draft()]);
  const finding = result.findings[0];

  const first = recordVerdicts(root, result, [{ findingId: finding.id, verdict: "confirmed", evidence: "redundant wrapper" }], stateRoot);
  assert.equal(first, 1);
  const recordedAt = verdictLedger(root, stateRoot)[0].createdAt;
  const second = recordVerdicts(root, result, [{ findingId: finding.id, verdict: "confirmed", evidence: "redundant wrapper" }], stateRoot);
  assert.equal(second, 0);
  assert.equal(verdictLedger(root, stateRoot)[0].createdAt, recordedAt);

  const changed = recordVerdicts(root, result, [{ findingId: finding.id, verdict: "dismissed", evidence: "exported compatibility API" }], stateRoot);
  assert.equal(changed, 1);
  assert.equal(verdictLedger(root, stateRoot)[0].verdict, "dismissed");
});

test("verdict statistics aggregate per rule family", () => {
  const root = fixture();
  const stateRoot = path.join(root, "state");
  const result = resultWith(root, [
    draft({ ruleId: "errors.suppressed", anchor: "a", line: 1 }),
    draft({ ruleId: "errors.suppressed", anchor: "b", line: 2 }),
    draft({ ruleId: "structure.pass-through-wrapper", anchor: "c", line: 3 }),
  ]);
  recordVerdicts(root, result, [
    { findingId: result.findings[0].id, verdict: "confirmed", evidence: "empty catch" },
    { findingId: result.findings[1].id, verdict: "dismissed", evidence: "documented boundary" },
    { findingId: result.findings[2].id, verdict: "needs-context", evidence: "contract unavailable" },
  ], stateRoot);
  const stats = verdictStats(verdictLedger(root, stateRoot));
  assert.equal(stats.length, 2);
  assert.deepEqual(stats[0], { ruleId: "errors.suppressed", total: 2, confirmed: 1, dismissed: 1, needsContext: 0 });
  assert.deepEqual(stats[1], { ruleId: "structure.pass-through-wrapper", total: 1, confirmed: 0, dismissed: 0, needsContext: 1 });
  assert.deepEqual(verdictStats([]), []);
});

test("verdict manifest serializes the delta and writes atomically", () => {
  const root = fixture();
  const stateRoot = path.join(root, "state");
  const result = resultWith(root, [draft()]);
  const finding = result.findings[0];
  recordVerdicts(root, result, [{ findingId: finding.id, verdict: "confirmed", evidence: "redundant wrapper" }], stateRoot);

  const delta = classifyVerdicts(result.findings, verdictLedger(root, stateRoot));
  const manifest = verdictManifest(result, delta);
  assert.equal(manifest.candidates, 1);
  assert.equal(manifest.adjudicated.length, 1);
  assert.equal(manifest.adjudicated[0].status, "same");
  assert.equal(manifest.adjudicated[0].verdict, "confirmed");
  assert.equal(manifest.scanId, result.scanId);

  const exportPath = path.join(root, "reports", "verdicts.json");
  const written = writeVerdictManifest(root, result, delta, exportPath);
  assert.equal(written, exportPath);
  const parsed = JSON.parse(readFileSync(exportPath, "utf8")) as { candidates: number; adjudicated: Array<{ findingId: string }> };
  assert.equal(parsed.candidates, 1);
  assert.equal(parsed.adjudicated[0].findingId, finding.id);
});

test("finding queues omit report-only families by default and note the omission", () => {
  const root = fixture();
  const result = resultWith(root, [
    draft({ ruleId: "assurance.no-linked-tests", anchor: "coverage-a", line: 1 }),
    draft({ ruleId: "errors.suppressed", anchor: "suppress-b", line: 2 }),
  ]);
  const page = createFindingQueue(result, { reportOnly: ["assurance.no-linked-tests"] });
  assert.equal(page.queueSize, 1);
  assert.equal(page.reportOnlyOmitted, 1);
  assert.equal(page.totalFindings, 2);
  assert.match(page.text, /report-only candidate\(s\) omitted/);
  assert.match(page.findings[0].finding.ruleId, /errors\.suppressed/);

  const full = createFindingQueue(result);
  assert.equal(full.queueSize, 2);
  assert.equal(full.reportOnlyOmitted, 0);

  const representatives = createFindingQueue(result, { representatives: true, reportOnly: ["assurance.no-linked-tests"] });
  assert.equal(representatives.queueSize, 1);
});
