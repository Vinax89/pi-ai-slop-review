import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/core/config.ts";
import { createFinding, createScanResult, isScanResult } from "../src/core/schema.ts";
import { StateStore } from "../src/core/store.ts";
import { evaluateCorpus, loadCorpus } from "../src/evaluation/corpus.ts";
import type { FindingDraft } from "../src/types.ts";

function draft(line: number, start: number): FindingDraft {
  return {
    anchor: "module:missing",
    ruleId: "dependency.unresolved",
    classification: "defect",
    confidence: "C2",
    risk: "R2",
    maximumAction: "observe",
    filePath: "src/input.ts",
    line,
    column: 1,
    start,
    end: start + 7,
    sourceHash: "abc",
    message: "Module is unresolved",
    evidence: ["resolver found no target"],
    counterEvidence: [],
    unknown: [],
  };
}

test("finding fingerprints survive line-only movement and retain exact evidence ranges", () => {
  const first = createFinding(draft(2, 10), "test", "1");
  const moved = createFinding(draft(20, 200), "test", "1");
  assert.equal(first.finding.id, moved.finding.id);
  assert.equal(first.finding.start, 10);
  assert.equal(moved.finding.start, 200);
  assert.equal(first.finding.evidenceIds.length, 1);
  assert.equal(first.evidenceRecords[0].source?.sourceHash, "abc");
});

test("scan results are versioned and content addressed", () => {
  const result = createScanResult({
    engine: "typescript-semantic",
    engineVersion: "test",
    rootDir: "/tmp/project",
    providerId: "test",
    providerVersion: "1",
    providerCapabilities: ["syntax"],
    scannedFiles: ["src/input.ts"],
    findings: [draft(2, 10)],
    skipped: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(result.schemaVersion, 1);
  assert.ok(result.scanId.startsWith("scan:"));
  assert.equal(result.scope.paths[0], "src/input.ts");
  assert.equal(result.evidenceRecords.length, 1);
  assert.equal(result.completeness?.status, "complete");
  assert.equal(isScanResult(result), true);
});

test("state store uses revision checks and keeps repository state outside the project", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-repo-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-state-"));
  const store = new StateStore(root, stateRoot);
  const initial = store.load();
  assert.equal(initial.revision, 0);
  const saved = store.update((state) => {
    state.baselines.main = createScanResult({
      engine: "semantic-review",
      engineVersion: "test",
      rootDir: root,
      providerId: "test",
      providerVersion: "1",
      scannedFiles: [],
      findings: [],
      skipped: [],
    });
  });
  assert.equal(saved.revision, 1);
  assert.equal(store.load().baselines.main.schemaVersion, 1);
  assert.throws(() => store.save(initial), /revision conflict/);
  assert.equal(path.relative(root, store.statePath).startsWith(".."), true);
});

test("state store recovers from a corrupt live file and migrates additive v1 fields", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-repo-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-state-"));
  const store = new StateStore(root, stateRoot);
  store.update((state) => { state.revision = state.revision; });
  store.update((state) => { state.revision = state.revision; });
  writeFileSync(store.statePath, "{broken", "utf8");
  assert.equal(store.load().revision, 1);

  const migrationRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-state-migration-"));
  const migrationStore = new StateStore(root, migrationRoot);
  const legacyScan = createScanResult({
    engine: "semantic-review",
    engineVersion: "test",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [],
    skipped: [],
  });
  delete (legacyScan as Partial<typeof legacyScan>).completeness;
  mkdirSync(migrationStore.directory, { recursive: true });
  writeFileSync(migrationStore.statePath, JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    repositoryId: migrationStore.repositoryId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessions: {},
    suppressions: [],
    feedback: [],
    baselines: { main: legacyScan },
  }));
  const migrated = migrationStore.load();
  assert.deepEqual(migrated.proposals, []);
  assert.deepEqual(migrated.labRuns, []);
  assert.equal(migrated.baselines.main.completeness?.status, "complete");
});

test("state store refuses a lock owned by a live process", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-repo-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-state-"));
  const store = new StateStore(root, stateRoot);
  store.load();
  writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  assert.throws(() => store.update(() => undefined), /locked by another live process/);
});

test("project configuration is ignored until explicitly trusted", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-config-"));
  mkdirSync(path.join(root, ".pi"));
  writeFileSync(path.join(root, ".pi", "ai-slop.json"), JSON.stringify({ network: { enabled: true } }));
  const globalPath = path.join(root, "missing-global.json");
  const untrusted = loadConfig(root, { globalPath });
  assert.equal(untrusted.config.network.enabled, false);
  assert.match(untrusted.warnings.join("\n"), /ignored until.*trusted/);
  const trusted = loadConfig(root, { globalPath, trustProjectConfig: true });
  assert.equal(trusted.config.network.enabled, true);
});

test("corpus loader and evaluator count unsafe hard-negative actions", async () => {
  const cases = loadCorpus(new URL("../library/cases.jsonl", import.meta.url).pathname);
  assert.ok(cases.length >= 13);
  const evaluation = await evaluateCorpus(cases.slice(0, 1), async (corpusCase) =>
    createScanResult({
      engine: "semantic-review",
      engineVersion: "test",
      rootDir: "/tmp/project",
      providerId: "test",
      providerVersion: "1",
      scannedFiles: ["input.ts"],
      findings: [{ ...draft(1, 0), ruleId: corpusCase.rule_id, maximumAction: corpusCase.expected_action }],
      skipped: [],
    }),
  );
  assert.equal(evaluation.total, 1);
  assert.equal(evaluation.passed, 1);
  assert.equal(evaluation.unsafeHardNegativeActions, 0);
});
