import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createScanResult } from "../src/core/schema.ts";
import { evaluateCorpus, loadCorpus, validateCorpus } from "../src/evaluation/corpus.ts";
import { scanFiles } from "../src/scan.ts";
import type { CorpusCase } from "../src/evaluation/corpus.ts";
import type { FindingDraft } from "../src/types.ts";

function finding(corpusCase: CorpusCase, confidence = corpusCase.expected_confidence ?? "C1"): FindingDraft {
  const counterEvidence = corpusCase.veto === "public-api"
    ? ["symbol is exported"]
    : corpusCase.veto === "explicit-return-contract"
      ? ["wrapper declares an explicit return contract"]
      : corpusCase.veto === "overload"
        ? ["symbol has declarations or overloads"]
        : [];
  return {
    anchor: corpusCase.anchor,
    ruleId: corpusCase.rule_id,
    classification: corpusCase.label === "waste_candidate" ? "waste_candidate" : "context_conflict",
    confidence,
    risk: "R2",
    maximumAction: corpusCase.expected_action === "ignore" ? "observe" : corpusCase.expected_action,
    filePath: "input.ts",
    line: 1,
    column: 1,
    start: 0,
    end: 1,
    sourceHash: "test-source",
    message: "deterministic corpus fixture",
    evidence: ["fixture"],
    counterEvidence,
    unknown: [],
  };
}

test("corpus evaluation enforces expected confidence and declared vetoes", async () => {
  const corpusCase: CorpusCase = {
    id: "confidence-veto",
    repository: "fixture",
    split: "train",
    rule_id: "structure.pass-through-wrapper",
    anchor: "corpus:confidence-veto",
    language: "typescript",
    label: "hard_negative",
    source: "export function wrapper(value: string) { return target(value); }",
    expected_confidence: "C2",
    expected_action: "observe",
    veto: "public-api",
  };
  const passing = await evaluateCorpus([corpusCase], async () => createScanResult({
    engine: "semantic-review",
    engineVersion: "test",
    rootDir: "/tmp/evaluation",
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [finding(corpusCase)],
    skipped: [],
  }));
  assert.equal(passing.passed, 1);
  assert.equal(passing.cases[0]?.vetoMatched, true);

  const failing = await evaluateCorpus([corpusCase], async () => createScanResult({
    engine: "semantic-review",
    engineVersion: "test",
    rootDir: "/tmp/evaluation",
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [finding(corpusCase, "C1")],
    skipped: [],
  }));
  assert.equal(failing.passed, 0);
  assert.match(failing.cases[0]?.diagnostic ?? "", /expected confidence C2/);
});

test("corpus validation rejects duplicate IDs, split leakage, and missing splits", () => {
  const base = (id: string, split: CorpusCase["split"], repository = id): CorpusCase => ({
    id,
    repository,
    split,
    rule_id: "test.rule",
    anchor: `corpus:${id}`,
    language: "typescript",
    label: "ambiguous",
    source: "const value = 1;",
    expected_action: "ignore",
  });
  assert.throws(() => validateCorpus([base("same", "train"), base("same", "validation")]), /duplicate corpus case id/);
  assert.throws(() => validateCorpus([base("train", "train", "shared"), base("validation", "validation", "shared")], { enforceRepositoryIsolation: true }), /multiple splits/);
  assert.throws(() => validateCorpus([base("train", "train")], { requireAllSplits: true }), /missing required split/);
});

test("corpus evaluation selects only the declared case anchor", async () => {
  const corpusCase: CorpusCase = {
    id: "anchor-selection",
    repository: "fixture",
    split: "train",
    rule_id: "structure.pass-through-wrapper",
    anchor: "function:expected",
    language: "typescript",
    label: "hard_negative",
    source: "function expected(value: string) { return target(value); }",
    expected_action: "ignore",
  };
  const unrelated = { ...finding({ ...corpusCase, anchor: "function:unrelated" }), maximumAction: "propose" as const };
  const evaluation = await evaluateCorpus([corpusCase], async () => createScanResult({
    engine: "semantic-review",
    engineVersion: "test",
    rootDir: "/tmp/evaluation",
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [unrelated],
    skipped: [],
  }));
  assert.equal(evaluation.passed, 1);
  assert.equal(evaluation.cases[0]?.actualAction, "ignore");
});

test("bundled corpus covers every split and hard negatives under deterministic evaluation", async () => {
  const cases = loadCorpus(new URL("../library/cases.jsonl", import.meta.url).pathname);
  const evaluation = await evaluateCorpus(cases, async (corpusCase) => createScanResult({
    engine: "semantic-review",
    engineVersion: "test",
    rootDir: "/tmp/evaluation",
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: corpusCase.expected_action === "ignore" ? [] : [finding(corpusCase)],
    skipped: [],
  }));
  assert.equal(evaluation.passed, evaluation.total);
  assert.ok(evaluation.hardNegatives > 0);
  assert.ok(evaluation.bySplit.train.total > 0);
  assert.ok(evaluation.bySplit.validation.total > 0);
  assert.ok(evaluation.bySplit.holdout.total > 0);
  assert.ok(evaluation.byLanguage.javascript.total > 0);
});

test("JavaScript and Python inputs both scan through the compatibility path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-evaluation-compat-"));
  try {
    writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { allowJs: true, checkJs: true, module: "NodeNext", moduleResolution: "NodeNext", strict: true } }));
    writeFileSync(path.join(root, "input.js"), "export function wrapper(value) { return target(value); }\n");
    writeFileSync(path.join(root, "input.py"), "def wrapper(value):\n    return target(value)\n");
    const javascript = await scanFiles(root, ["input.js"], undefined, "explicit");
    const python = await scanFiles(root, ["input.py"], undefined, "explicit");
    assert.deepEqual(javascript.scannedFiles, ["input.js"]);
    assert.deepEqual(python.scannedFiles, ["input.py"]);
    assert.equal(javascript.skipped.length, 0);
    assert.equal(python.skipped.length, 0);
    assert.equal(javascript.engine, "provider-federation");
    assert.equal(python.engine, "provider-federation");
    assert.ok(javascript.findings.some((item) => item.ruleId === "structure.pass-through-wrapper"));
    assert.ok(python.findings.some((item) => item.ruleId === "structure.pass-through-wrapper"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
