import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { runIndependentCritics, validateCriticResponse } from "../src/experiments/critics.ts";
import { runExpressionExperiment } from "../src/experiments/expression.ts";
import { runSmtEquivalence, runTranslationValidation } from "../src/experiments/formal.ts";
import { retrieveRepositoryContext } from "../src/experiments/retrieval.ts";
import { collectGraphEvidence } from "../src/graph/provider.ts";
import { createScanResult } from "../src/core/schema.ts";
import type { ExperimentSpec } from "../src/types.ts";

function spec(overrides: Partial<ExperimentSpec> = {}): ExperimentSpec {
  return {
    id: "expression",
    kind: "expression-equivalence",
    original: "x + 0",
    candidate: "x * 1",
    variables: [{ name: "x", type: "integer", minimum: -10, maximum: 10 }],
    properties: [],
    metamorphic: [],
    maximumCases: 1_000,
    ...overrides,
  };
}

test("bounded expression engine combines shadow execution, exhaustive equivalence, invariants, mutations, equality saturation, and CEGIS", () => {
  const result = runExpressionExperiment(spec());
  assert.equal(result.status, "verified");
  assert.equal(result.cases, 21);
  assert.equal(result.counterexamples.length, 0);
  assert.equal(result.equalitySaturation.equivalent, true);
  assert.equal(result.cegis.candidate, "x");
  assert.equal(result.invariants.original.minimum, -10);
  assert.ok(result.mutation.generated > 0);
  assert.ok((result.mutation.score ?? 0) > 0);
  assert.match(result.assumptions.join(" "), /finite domain was exhausted/);
});

test("equality saturation closes commutative and associative rewrite classes", () => {
  const result = runExpressionExperiment(spec({
    original: "(x + 1) + 2",
    candidate: "x + (2 + 1)",
  }));
  assert.equal(result.status, "verified");
  assert.equal(result.equalitySaturation.equivalent, true);
});

test("counterexamples become bounded regression cases", () => {
  const result = runExpressionExperiment(spec({ original: "x + 1", candidate: "x + 2" }));
  assert.equal(result.status, "refuted");
  assert.ok(result.counterexamples.length > 0);
  assert.deepEqual(result.generatedRegressionCases[0], { x: -10 });
  assert.match(result.generatedRegressionTests[0], /expect\(capture/);
});

test("property and metamorphic checks are evaluated for both original and candidate", () => {
  const result = runExpressionExperiment(
    spec({
      original: "x * x",
      candidate: "x * x",
      properties: ["result >= 0"],
      metamorphic: [{ name: "sign symmetry", transform: { x: "-x" }, relation: "equal" }],
    }),
  );
  assert.equal(result.status, "verified");
  assert.equal(result.metamorphic[0].passed, true);
  assert.equal(result.invariants.candidate.nonnegative, true);
});

test("unsupported or unsafe expression syntax abstains explicitly", () => {
  const result = runExpressionExperiment(spec({ candidate: "dangerous(x)" }));
  assert.equal(result.status, "abstained");
  assert.match(result.diagnostic ?? "", /token|unexpected/);
  assert.equal(result.cases, 0);
});

test("SMT and translation-validation adapters are feature-gated, allowlisted, isolated, and parse bounded verdicts", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ai-slop-formal-"));
  const smtServer = path.join(directory, "smt.cjs");
  const aliveServer = path.join(directory, "alive.cjs");
  writeFileSync(smtServer, "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(!input.includes('(check-sat)'))process.exit(2);console.log('unsat');});\n");
  writeFileSync(aliveServer, "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{if(!input.includes('define'))process.exit(2);console.log('Transformation seems to be correct!');});\n");
  const config = structuredClone(DEFAULT_CONFIG);
  config.execution.trusted = true;
  config.experiments.smt = true;
  config.experiments.translationValidation = true;
  const smtCommand = [process.execPath, smtServer];
  const aliveCommand = [process.execPath, aliveServer];
  config.execution.commands = [smtCommand.join(" "), aliveCommand.join(" ")];

  const smt = await runSmtEquivalence(spec(), smtCommand, config, true);
  assert.equal(smt.status, "verified");
  assert.equal(smt.engine, "smt");
  const translation = await runTranslationValidation("define i32 @src(i32 %x) { ret i32 %x }", aliveCommand, config, true);
  assert.equal(translation.status, "verified");
  const blocked = await runSmtEquivalence(spec(), smtCommand, config, false);
  assert.equal(blocked.status, "abstained");
  assert.match(blocked.output, /project trust/);
});

test("repository-aware retrieval ranks local graph context without remote source disclosure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-retrieval-"));
  const state = mkdtempSync(path.join(tmpdir(), "ai-slop-retrieval-state-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }));
  writeFileSync(path.join(root, "src/payday.ts"), "export function calculatePaydaySafety(value: number) { return value >= 0; }\n");
  await collectGraphEvidence(root, ["src/payday.ts"], structuredClone(DEFAULT_CONFIG), undefined, state);
  const retrieved = retrieveRepositoryContext(root, "payday safety", 10, state);
  assert.equal(retrieved.results[0].node.name, "calculatePaydaySafety");
  assert.ok(retrieved.results[0].reasons.includes("public-surface symbol"));
});

test("critic panel is opt-in and non-abstaining responses require valid deterministic evidence citations", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-critics-"));
  const scan = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [{
      anchor: "example",
      ruleId: "errors.suppressed",
      classification: "context_conflict",
      confidence: "C2",
      risk: "R2",
      maximumAction: "observe",
      filePath: "input.ts",
      line: 1,
      column: 1,
      start: 0,
      end: 1,
      sourceHash: "hash",
      message: "suppressed",
      evidence: ["empty handler"],
      counterEvidence: [],
      unknown: [],
    }],
    skipped: [],
  });
  const disabled = await runIndependentCritics(scan.findings[0], scan.evidenceRecords, structuredClone(DEFAULT_CONFIG), undefined, {}, undefined);
  assert.equal(disabled.length, 4);
  assert.ok(disabled.every((assessment) => assessment.verdict === "abstain"));
  const evidenceId = scan.evidenceRecords[0].id;
  const valid = validateCriticResponse("finding-advocate", JSON.stringify({ verdict: "support", citedEvidenceIds: [evidenceId], analysis: "supported" }), new Set([evidenceId]));
  assert.equal(valid.valid, true);
  const invalid = validateCriticResponse("finding-advocate", JSON.stringify({ verdict: "support", citedEvidenceIds: ["invented"], analysis: "unsupported" }), new Set([evidenceId]));
  assert.equal(invalid.verdict, "abstain");
  assert.equal(invalid.valid, false);
});
