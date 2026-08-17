import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createScanResult } from "../src/core/schema.ts";
import { createFindingQueue, parseVerdictLines, verifyVerdicts } from "../src/report.ts";
import { adjudicationContextFingerprint, classifyVerdicts, formatVerdictDelta, recordVerdicts, suggestReportOnlyRules, verdictLedger, verdictManifest, verdictStats, verdictToFeedbackOutcome, writeVerdictManifest, type VerdictStats } from "../src/verdicts.ts";
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

function resultWith(root: string, findings: FindingDraft[], mode: "session" | "explicit" | "delta" | "repository" = "session", scannedFiles = ["input.ts"]) {
  return createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles,
    findings,
    skipped: [],
    mode,
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

test("unchanged finding source is invalidated when caller context changes", () => {
  const root = fixture();
  const stateRoot = path.join(root, "state");
  writeFileSync(path.join(root, "caller.ts"), "export const used = value();\n");
  const first = resultWith(root, [draft()], "repository", ["input.ts", "caller.ts"]);
  recordVerdicts(root, first, [{ findingId: first.findings[0].id, verdict: "dismissed", rationale: "public caller uses wrapper" }], stateRoot);
  writeFileSync(path.join(root, "caller.ts"), "export const used = 1;\n");
  const second = resultWith(root, [draft()], "repository", ["input.ts", "caller.ts"]);
  assert.equal(first.findings[0].sourceHash, second.findings[0].sourceHash);
  assert.equal(classifyVerdicts(root, second, verdictLedger(root, stateRoot)).findings[0].classification.status, "context-changed");
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

test("verdict ledger uses context fingerprints and scope-aware resolution", () => {
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

  let delta = classifyVerdicts(root, result, verdictLedger(root, stateRoot));
  assert.equal(delta.findings[0].classification.status, "reusable");
  assert.equal(delta.resolved.length, 0);

  const changed = resultWith(root, [draft({ sourceHash: "hash-v2" })]);
  delta = classifyVerdicts(root, changed, verdictLedger(root, stateRoot));
  assert.equal(delta.findings[0].classification.status, "context-changed");

  const empty = resultWith(root, []);
  delta = classifyVerdicts(root, empty, verdictLedger(root, stateRoot));
  assert.equal(delta.findings.length, 0);
  assert.equal(delta.resolved.length, 0);
  assert.equal(delta.notObserved.length, 1);

  const full = resultWith(root, [], "repository");
  delta = classifyVerdicts(root, full, verdictLedger(root, stateRoot));
  assert.equal(delta.resolved.length, 1);
  assert.equal(delta.notObserved.length, 0);
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
  assert.throws(
    () => recordVerdicts(root, result, [{ findingId: finding.id, verdict: "confirmed", rationale: "cited", evidenceIds: ["evidence:unknown"] }], stateRoot),
    /references unknown evidence/,
  );
  assert.throws(
    () => recordVerdicts(root, result, [
      { findingId: finding.id, verdict: "confirmed", evidence: "first" },
      { findingId: finding.id, verdict: "dismissed", evidence: "second" },
    ], stateRoot),
    /duplicate finding IDs/,
  );
  assert.throws(
    () => recordVerdicts(root, result, [{ findingId: finding.id, verdict: "confirmed", evidence: "x".repeat(2_001) }], stateRoot),
    /rationale exceeds 2000 characters/,
  );
  assert.throws(
    () => recordVerdicts(root, result, [{ findingId: finding.id, verdict: "confirmed", evidence: " ".repeat(2_001) }], stateRoot),
    /rationale exceeds 2000 characters/,
  );
  assert.throws(
    () => recordVerdicts(root, result, [{ findingId: finding.id, verdict: "confirmed", evidence: "reviewed", evidenceIds: Array(51).fill(finding.evidenceIds[0]) }], stateRoot),
    /exceeds 50 evidence IDs/,
  );
  recordVerdicts(root, result, [{ findingId: finding.id, verdict: "confirmed", evidence: "safe\nforged heading\u0000" }], stateRoot);
  assert.equal(verdictLedger(root, stateRoot)[0].evidence, "safe forged heading");
});

test("verdict rendering normalizes legacy multiline rationale", () => {
  const root = fixture();
  const result = resultWith(root, [draft()]);
  const finding = result.findings[0];
  const record = {
    schemaVersion: result.schemaVersion, findingId: finding.id, ruleId: finding.ruleId, filePath: finding.filePath,
    line: finding.line, anchor: finding.anchor, sourceHash: finding.sourceHash,
    adjudicationContextFingerprint: adjudicationContextFingerprint(root, result, finding), scanScope: result.scope, verdict: "confirmed" as const,
    evidence: "first line\n## forged section\u0000", evidenceIds: [], scanId: "scan:old",
    createdAt: new Date().toISOString(), repositoryId: "repository:test",
  };
  const delta = classifyVerdicts(root, result, [record]);
  assert.doesNotMatch(formatVerdictDelta(delta), /\n## forged/);
  assert.doesNotMatch(verdictManifest(result, delta).adjudicated[0]?.evidence ?? "", /[\n\u0000]/);
});

test("verdict recording enforces the checkpoint batch bound", () => {
  const root = fixture();
  const findings = Array.from({ length: 21 }, (_, index) => draft({ anchor: `item-${index}`, line: index + 1 }));
  const result = resultWith(root, findings);
  assert.throws(() => recordVerdicts(root, result, result.findings.map((finding) => ({
    findingId: finding.id, verdict: "confirmed" as const, evidence: "reviewed",
  })), path.join(root, "state")), /1 to 20 entries/);
  assert.throws(() => recordVerdicts(root, result, [null as never], path.join(root, "state")), /findingId must be/);
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

test("report-only suggestions require enough reviews and a high dismissal rate", () => {
  const make = (ruleId: string, total: number, dismissed: number): VerdictStats => ({
    ruleId, total,
    confirmed: total - dismissed,
    dismissed,
    needsContext: 0,
  });
  assert.deepEqual(suggestReportOnlyRules([make("noise.rule", 5, 4)]), ["noise.rule"]);
  assert.deepEqual(suggestReportOnlyRules([make("noise.rule", 5, 3)]), []);
  assert.deepEqual(suggestReportOnlyRules([make("noise.rule", 4, 4)]), []);
  assert.deepEqual(suggestReportOnlyRules([make("a.rule", 6, 5), make("b.rule", 6, 1)]), ["a.rule"]);
  assert.deepEqual(suggestReportOnlyRules([]), []);
});

test("verdict manifest serializes the delta and writes atomically", () => {
  const root = fixture();
  const stateRoot = path.join(root, "state");
  const result = resultWith(root, [draft()]);
  const finding = result.findings[0];
  recordVerdicts(root, result, [{ findingId: finding.id, verdict: "confirmed", evidence: "redundant wrapper" }], stateRoot);

  const delta = classifyVerdicts(root, result, verdictLedger(root, stateRoot));
  const manifest = verdictManifest(result, delta);
  assert.equal(manifest.candidates, 1);
  assert.equal(manifest.adjudicated.length, 1);
  assert.equal(manifest.adjudicated[0].status, "reusable");
  assert.equal(manifest.adjudicated[0].verdict, "confirmed");
  assert.equal(manifest.scanId, result.scanId);

  const exportPath = path.join(root, "reports", "verdicts.json");
  const written = writeVerdictManifest(root, result, delta, exportPath);
  assert.equal(written, exportPath);
  const parsed = JSON.parse(readFileSync(exportPath, "utf8")) as { candidates: number; adjudicated: Array<{ findingId: string }> };
  assert.equal(parsed.candidates, 1);
  assert.equal(parsed.adjudicated[0].findingId, finding.id);
});

test("verdict manifest rejects traversal and symlink escapes", () => {
  const root = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), "ai-slop-verdicts-outside-"));
  const result = resultWith(root, [draft()]);
  const delta = classifyVerdicts(root, result, []);
  assert.throws(() => writeVerdictManifest(root, result, delta, path.join("..", "escaped.json")), /outside the project root/);
  mkdirSync(path.join(root, "reports"));
  symlinkSync(outside, path.join(root, "reports", "linked"));
  assert.throws(() => writeVerdictManifest(root, result, delta, path.join("reports", "linked", "escaped.json")), /outside the project root/);
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
  const nonFinite = createFindingQueue(result, { offset: Number.NaN, limit: Number.POSITIVE_INFINITY });
  assert.equal(nonFinite.offset, 0);
  assert.equal(nonFinite.findings.length, 2);

  const resumed = createFindingQueue(result, { excludeFindingIds: new Set([full.findings[0]!.finding.id]) });
  assert.equal(resumed.totalFindings, 2);
  assert.equal(resumed.queueSize, 1);
  assert.equal(resumed.alreadyAdjudicated, 1);
  assert.match(resumed.text, /1 already adjudicated for this scan/);
});
