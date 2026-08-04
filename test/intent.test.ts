import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assessIntent, formatIntentAssessment } from "../src/core/intent.ts";
import { analyzeForensics, calibrateProjectSignals } from "../src/core/forensics.ts";
import { createScanResult } from "../src/core/schema.ts";

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-intent-"));
  writeFileSync(path.join(root, "input.ts"), "export function wrapper(value: string) { return value; }\n");
  return root;
}

function result(options: { skipped?: Array<{ filePath: string; reason: string }>; counterEvidence?: string[] } = {}) {
  return createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: fixture(),
    providerId: "typescript-semantic",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [{
      anchor: "function:wrapper",
      ruleId: "structure.pass-through-wrapper",
      classification: "context_conflict",
      confidence: "C2",
      risk: "R2",
      maximumAction: "propose",
      filePath: "input.ts",
      line: 1,
      column: 1,
      start: 0,
      end: 51,
      sourceHash: "hash",
      message: "wrapper forwards arguments without transformation",
      evidence: ["pass-through body"],
      counterEvidence: options.counterEvidence ?? [],
      unknown: [],
    }],
    evidenceRecords: [{
      schemaVersion: 1,
      id: "registration-context",
      providerId: "repository-graph",
      providerVersion: "1",
      kind: "reference",
      summary: "framework/runtime registration for wrapper",
      strength: "C2",
      source: { filePath: "input.ts", line: 1, column: 1, start: 0, end: 51, sourceHash: "hash" },
      details: { callers: ["caller"], tests: ["test"], governingSpecifications: ["spec"] },
    }],
    skipped: options.skipped ?? [],
  });
}

test("intent engine exposes competing intentional hypotheses from context", () => {
  const scan = result();
  const assessment = assessIntent(scan.findings[0], scan);
  assert.equal(assessment.status, "supported");
  assert.equal(assessment.actionLimit, "propose");
  assert.equal(assessment.humanDecisionRequired, true);
  assert.ok(assessment.hypotheses.some((item) => item.kind === "framework-required"));
  assert.ok(assessment.criteria.some((item) => /not AI-slop by itself/.test(item)));
  assert.ok(assessment.decisionTrace.some((step) => step.id === "behavioral-contract" && step.result === "pass"));
});

test("incomplete scans produce unknown intent and cap action at observation", () => {
  const scan = result({ skipped: [{ filePath: "other.ts", reason: "omitted by limit" }] });
  const assessment = assessIntent(scan.findings[0], scan);
  assert.equal(assessment.status, "unknown");
  assert.equal(assessment.actionLimit, "observe");
  assert.ok(assessment.missingContext.some((item) => /Complete repository context/.test(item)));
});

test("counterevidence makes intent contested and blocks proposal authority", () => {
  const scan = result({ counterEvidence: ["local convention requires this wrapper"] });
  const assessment = assessIntent(scan.findings[0], scan);
  assert.equal(assessment.status, "contested");
  assert.equal(assessment.actionLimit, "observe");
  assert.ok(assessment.decisionTrace.some((step) => step.id === "deterministic-defect" && step.result === "conflict"));
});

test("context counts are deduplicated and independent providers are visible", () => {
  const scan = result();
  scan.evidenceRecords[0].details = { callers: ["caller", "caller"], tests: ["test", "test"], governingSpecifications: ["spec", "spec"] };
  const assessment = assessIntent(scan.findings[0], scan);
  assert.equal(assessment.context.callers, 1);
  assert.equal(assessment.context.tests, 1);
  assert.equal(assessment.context.specifications, 1);
  assert.equal(assessment.context.independentProviders, 2);
  assert.equal(assessment.context.relevantCompleteness, "complete");
  assert.ok(assessment.decisionTrace.some((step) => step.id === "evidence-diversity" && step.result === "pass"));
});

test("generated origins add ownership review and cap action", () => {
  const scan = result();
  scan.findings[0].filePath = "vendor/input.ts";
  const assessment = assessIntent(scan.findings[0], scan);
  assert.ok(assessment.context.generatedSignals > 0);
  assert.ok(assessment.hypotheses.some((item) => item.kind === "generated-or-vendored"));
  assert.equal(assessment.actionLimit, "observe");
  assert.ok(assessment.missingContext.some((item) => /regeneration rules/.test(item)));
});

test("dynamic unknowns produce an explicit external-context hypothesis", () => {
  const scan = result();
  scan.findings[0].unknown = ["dynamic runtime registration and external consumers are not represented"];
  const assessment = assessIntent(scan.findings[0], scan);
  assert.ok(assessment.context.dynamicSignals > 0);
  assert.ok(assessment.hypotheses.some((item) => item.kind === "external-or-dynamic-context"));
  assert.equal(assessment.status, "contested");
  assert.equal(assessment.actionLimit, "observe");
});

test("absence of intent context remains an unknown suspicious structure", () => {
  const scan = result();
  scan.evidenceRecords = [];
  const assessment = assessIntent(scan.findings[0], scan);
  assert.equal(assessment.status, "unknown");
  assert.ok(assessment.hypotheses.some((item) => item.kind === "suspicious-structure"));
  assert.ok(assessment.missingContext.some((item) => /No callers/.test(item)));
});


test("paper-derived dimensions remain context-sensitive under a review profile", () => {
  const scan = result();
  const assessment = assessIntent(scan.findings[0], scan, {
    artifact: "library",
    task: "api-review",
    audience: "external consumers",
    expectedProperties: ["stable public contract"],
    toleratedPatterns: ["framework wrappers"],
    prohibitedPatterns: ["breaking API changes"],
  });
  assert.equal(assessment.profile.artifact, "library");
  assert.equal(assessment.profile.task, "api-review");
  assert.equal(assessment.profile.audience, "external consumers");
  assert.equal(assessment.dimensions.length, 7);
  assert.ok(assessment.dimensions.some((item) => item.dimension === "relevance" && item.status === "observed"));
  assert.ok(assessment.dimensions.some((item) => item.dimension === "templatedness" && item.status === "observed"));
  assert.ok(assessment.decisionTrace.some((step) => step.id === "review-profile" && step.result === "pass"));
  const formatted = formatIntentAssessment(assessment);
  assert.match(formatted, /HUMAN DECISION REQUIRED/);
  assert.match(formatted, /DECISION/);
  assert.match(formatted, /Quality dimensions:/);
  assert.match(formatted, /Profile: artifact=library, task=api-review/);
});

test("bounded forensic metrics stay descriptive and expose local repetition signals", () => {
  const metrics = analyzeForensics("Short sentence. A much longer sentence with several words for variance.", "text");
  assert.equal(metrics.inputKind, "text");
  assert.ok(metrics.tokenCount > 0);
  assert.ok(metrics.burstiness.coefficientOfVariation !== null);
  assert.ok(metrics.perplexityProxy.value !== null);
  assert.ok(metrics.limitations.some((item) => /model-free/.test(item)));

  const codeMetrics = analyzeForensics("if (value) { return value; }\nif (value) { return value; }\n", "code");
  assert.ok(codeMetrics.repetition.repeatedLineRate > 0);
  assert.ok(codeMetrics.logicDensity.controlTokenRate > 0);
  assert.ok(codeMetrics.repetition.boilerplateBlockCount > 0);
});

test("intent assessments keep forensic signals separate from evidence authority", () => {
  const metrics = analyzeForensics("A short local source sample.", "text");
  const assessment = assessIntent(result().findings[0], result(), undefined, metrics);
  assert.equal(assessment.forensics?.inputKind, "text");
  assert.ok(assessment.decisionTrace.some((step) => step.id === "forensic-signals" && step.result === "pass"));
  assert.match(formatIntentAssessment(assessment), /Forensics: kind=text/);
});

test("structural semantic metrics expose claims, dependency, and reordering signals", () => {
  const metrics = analyzeForensics(
    "The system requires test coverage for claim 42.\n\nThis verification uses the same claim and increases confidence.\n\nThe result must remain reproducible.",
    "text",
  );
  assert.ok(metrics.argumentDependency.dependencyRate > 0);
  assert.ok(metrics.claimDensity.falsifiableClaimRate > 0);
  assert.ok(metrics.interchangeability.interchangeabilityIndex !== null);
  assert.ok(metrics.claimDensity.jargonTokenRate >= 0);

  const calibration = calibrateProjectSignals([
    { sourceHash: "a", committedAt: "2026-01-01T00:00:00Z", logicDensity: 0.1, boilerplateRate: 0.2 },
    { sourceHash: "b", committedAt: "2026-01-02T00:00:00Z", logicDensity: 0.3, boilerplateRate: 0.4 },
  ]);
  assert.equal(calibration.sampleCount, 2);
  assert.ok(Math.abs((calibration.logicDensityDrift ?? 0) - 0.2) < Number.EPSILON);
  assert.ok(Math.abs((calibration.boilerplateRateDrift ?? 0) - 0.2) < Number.EPSILON);
});

test("interchangeability stays unknown when no lexical transition baseline exists", () => {
  const metrics = analyzeForensics("alpha one.\n\nbeta two.", "text");
  assert.equal(metrics.interchangeability.interchangeabilityIndex, null);
});