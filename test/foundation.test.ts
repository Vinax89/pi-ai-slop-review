import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/core/config.ts";
import { createFinding, createScanResult, isScanResult, mergeScanResults, scanIdFor } from "../src/core/schema.ts";
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

test("scan identity includes every scanned file content hash", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-hashes-"));
  writeFileSync(path.join(root, "a.ts"), "const a = 1;\n");
  writeFileSync(path.join(root, "b.ts"), "const b = 1;\n");
  const input = {
    engine: "semantic-review" as const,
    engineVersion: "test",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["a.ts", "b.ts"],
    findings: [],
    skipped: [],
  };
  const first = createScanResult(input);
  writeFileSync(path.join(root, "b.ts"), "const b = 2;\n");
  const second = createScanResult(input);
  assert.notEqual(first.scanId, second.scanId);
  assert.notEqual(first.scope.contentHash, second.scope.contentHash);
});

test("scan content hashing rejects traversal and external symlink paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-containment-root-"));
  const outside = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-containment-outside-"));
  const outsideFile = path.join(outside, "outside.ts");
  const linkPath = path.join(root, "linked.ts");
  writeFileSync(path.join(root, "inside.ts"), "const inside = 1;\n");
  writeFileSync(outsideFile, "const outside = 1;\n");
  symlinkSync(outsideFile, linkPath);
  const traversalPath = path.relative(root, outsideFile);
  const input = {
    engine: "semantic-review" as const,
    engineVersion: "test",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["inside.ts", "linked.ts", traversalPath],
    findings: [],
    skipped: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
  };

  const first = createScanResult(input);
  const mergedFirst = mergeScanResults(root, [first]);
  writeFileSync(outsideFile, "const outside = 2;\n");
  const second = createScanResult(input);
  const mergedSecond = mergeScanResults(root, [second]);

  assert.deepEqual(first.scannedFiles, [traversalPath, "inside.ts", "linked.ts"].sort());
  assert.equal(first.scope.contentHash, second.scope.contentHash);
  assert.equal(mergedFirst.scope.contentHash, mergedSecond.scope.contentHash);
  writeFileSync(path.join(root, "inside.ts"), "const inside = 2;\n");
  const changed = createScanResult(input);
  assert.notEqual(second.scope.contentHash, changed.scope.contentHash);
});

test("scan canonicalization retains lexical paths for missing files", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-containment-missing-"));
  const result = createScanResult({
    engine: "semantic-review",
    engineVersion: "test",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["missing.ts", "nested/also-missing.ts"],
    findings: [],
    skipped: [{ filePath: "missing.ts", reason: "not found" }],
  });
  assert.deepEqual(result.scannedFiles, ["missing.ts", "nested/also-missing.ts"]);
  assert.equal(result.skipped[0]?.filePath, "missing.ts");
});

test("scan result validation rejects malformed nested records", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-validation-"));
  const result = createScanResult({
    engine: "semantic-review",
    engineVersion: "test",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: [],
    findings: [],
    skipped: [],
  });
  const malformed: unknown = structuredClone(result);
  if (!malformed || typeof malformed !== "object" || !("providers" in malformed) || !Array.isArray(malformed.providers)) {
    throw new Error("test fixture unexpectedly malformed");
  }
  const provider = malformed.providers[0];
  if (!provider || typeof provider !== "object" || !("capabilities" in provider)) throw new Error("test provider missing");
  provider.capabilities = ["not-a-capability"];
  assert.equal(isScanResult(malformed), false);
});

test("scan identity includes finding and policy payloads", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-identity-"));
  const base = createScanResult({
    engine: "semantic-review",
    engineVersion: "test",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: [],
    findings: [draft(1, 0)],
    skipped: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  const changedFinding = createScanResult({
    engine: "semantic-review",
    engineVersion: "test",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: [],
    findings: [{ ...draft(1, 0), message: "A different payload" }],
    skipped: [],
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.notEqual(base.scanId, changedFinding.scanId);
  const changedPolicy = structuredClone(base);
  changedPolicy.policyDecisions = [{
    findingId: base.findings[0].id,
    originalConfidence: "C2",
    finalConfidence: "C1",
    originalAction: "observe",
    finalAction: "observe",
    evidenceScore: 0.5,
    reasons: ["focused regression"],
  }];
  changedPolicy.scanId = scanIdFor(changedPolicy);
  assert.notEqual(base.scanId, changedPolicy.scanId);
});

test("scan result validation enforces published bounds and closed records", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-validation-invariants-"));
  const result = createScanResult({
    engine: "semantic-review",
    engineVersion: "test",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: [],
    findings: [draft(1, 0)],
    skipped: [],
  });
  const invalidCoordinate = structuredClone(result);
  invalidCoordinate.findings[0].line = 0;
  assert.equal(isScanResult(invalidCoordinate), false);
  const extraProperty = structuredClone(result) as typeof result & { unexpected?: boolean };
  extraProperty.unexpected = true;
  assert.equal(isScanResult(extraProperty), false);
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

test("state store bounds baselines and moves session history to SQLite", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-bounded-state-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-bounded-state-root-"));
  const store = new StateStore(root, stateRoot);
  const scans = Array.from({ length: 25 }, (_, index) => createScanResult({
    engine: "semantic-review",
    engineVersion: "test",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: [],
    findings: [],
    skipped: [],
    generatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  const saved = store.update((state) => {
    for (const [index, scan] of scans.entries()) state.baselines[`baseline-${index}`] = scan;
    state.sessions.legacy = {
      id: "legacy",
      branchId: "main",
      updatedAt: "2026-01-01T00:00:00.000Z",
      events: [],
      scans,
      claims: [],
    };
  });

  assert.equal(Object.keys(saved.baselines).length, 20);
  assert.deepEqual(saved.sessions, {});
  assert.equal(store.loadSessions()[0]?.scans.length, 20);
  for (let index = 0; index < 105; index += 1) {
    store.saveSession({ id: `session-${index}`, branchId: "main", updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(), events: [], scans: [], claims: [] });
  }
  assert.equal(store.loadSessions(200).length, 100);
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
test("state clear invalidates stale snapshots without blocking fresh updates", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-state-clear-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-state-clear-root-"));
  const store = new StateStore(root, stateRoot);
  store.update((state) => { state.revision = state.revision; });
  const stale = store.load();
  store.clear();
  assert.equal(store.load().revision, 0);
  assert.throws(() => store.save(stale), /invalidated by clear/);
  assert.equal(store.update((state) => { state.feedback = []; }).revision, 1);
});

test("state save preserves a valid backup after recovering a corrupt primary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-state-recovery-"));
  const stateRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-state-root-"));
  const store = new StateStore(root, stateRoot);
  store.update(() => undefined);
  store.update(() => undefined);
  const backup = readFileSync(store.backupPath, "utf8");
  writeFileSync(store.statePath, "{broken", "utf8");
  store.update(() => undefined);
  assert.equal(readFileSync(store.backupPath, "utf8"), backup);
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
test("configuration overlays preserve inherited LSP and experiment settings while warning on malformed values", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-config-overlay-"));
  const globalPath = path.join(root, "global.json");
  mkdirSync(path.join(root, ".pi"));
  writeFileSync(globalPath, JSON.stringify({
    execution: { lspServers: { typescript: ["node", "--token", "global"], python: ["python3"] } },
    experiments: { smt: true },
  }));
  writeFileSync(path.join(root, ".pi", "ai-slop.json"), JSON.stringify({
    execution: { lspServers: { typescript: "malformed" } },
    experiments: { translationValidation: false, smt: "malformed" },
  }));
  const loaded = loadConfig(root, { globalPath, trustProjectConfig: true });
  assert.deepEqual(loaded.config.execution.lspServers.python, ["python3"]);
  assert.deepEqual(loaded.config.execution.lspServers.typescript, ["node", "--token", "global"]);
  assert.equal(loaded.config.experiments.smt, true);
  assert.equal(loaded.config.experiments.translationValidation, false);
  assert.match(loaded.warnings.join("\n"), /invalid LSP command|invalid experiment flag/);
});

test("configuration clamps resource limits to safe ceilings", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-config-limits-"));
  const globalPath = path.join(root, "global.json");
  writeFileSync(globalPath, JSON.stringify({
    limits: {
      maxFiles: Number.MAX_SAFE_INTEGER,
      maxFileBytes: Number.MAX_SAFE_INTEGER,
      commandTimeoutMs: Number.MAX_SAFE_INTEGER,
      maxOutputBytes: Number.MAX_SAFE_INTEGER,
      maxFindings: Number.MAX_SAFE_INTEGER,
    },
  }));
  const loaded = loadConfig(root, { globalPath });
  assert.deepEqual(loaded.config.limits, {
    maxFiles: 10_000,
    maxFileBytes: 4 * 1024 * 1024,
    commandTimeoutMs: 10 * 60_000,
    maxOutputBytes: 10 * 1024 * 1024,
    maxFindings: 5_000,
  });
  assert.equal(loaded.warnings.filter((warning) => warning.includes("clamped limits.")).length, 5);
});

test("report-only rules default to no-linked-tests and merge from configuration", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-config-rules-"));
  const globalPath = path.join(root, "global.json");
  const defaults = loadConfig(root, { globalPath });
  assert.deepEqual(defaults.config.rules.reportOnly, ["assurance.no-linked-tests"]);

  writeFileSync(globalPath, JSON.stringify({ rules: { reportOnly: ["assurance.no-linked-tests", "errors.suppressed"] } }));
  const extended = loadConfig(root, { globalPath });
  assert.deepEqual(extended.config.rules.reportOnly, ["assurance.no-linked-tests", "errors.suppressed"]);

  writeFileSync(globalPath, JSON.stringify({ rules: { reportOnly: "not-an-array" } }));
  const rejected = loadConfig(root, { globalPath });
  assert.deepEqual(rejected.config.rules.reportOnly, ["assurance.no-linked-tests"]);
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
      findings: [{ ...draft(1, 0), anchor: corpusCase.anchor, ruleId: corpusCase.rule_id, maximumAction: corpusCase.expected_action }],
      skipped: [],
    }),
  );
  assert.equal(evaluation.total, 1);
  assert.equal(evaluation.passed, 1);
  assert.equal(evaluation.unsafeHardNegativeActions, 0);
});
