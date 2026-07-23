import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { createScanResult, fingerprint } from "../src/core/schema.ts";
import {
  addSuppression,
  applyPolicy,
  conformalAcceptanceThreshold,
  recordFeedback,
  removeSuppression,
  selectiveRiskThreshold,
} from "../src/policy/engine.ts";
import { loadRulePolicies } from "../src/policy/rules.ts";
import { SCHEMA_VERSION, type EvidenceRecord, type Finding, type FindingDraft } from "../src/types.ts";

function fixture(): { root: string; state: string } {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-policy-"));
  const state = mkdtempSync(path.join(tmpdir(), "ai-slop-policy-state-"));
  writeFileSync(path.join(root, "input.ts"), "function wrapper(value: number) { return target(value); }\n");
  return { root, state };
}

function wrapper(): FindingDraft {
  return {
    anchor: "function:wrapper",
    ruleId: "structure.pass-through-wrapper",
    classification: "waste_candidate",
    confidence: "C2",
    risk: "R2",
    maximumAction: "propose",
    filePath: "input.ts",
    line: 1,
    column: 1,
    start: 0,
    end: 58,
    sourceHash: "hash",
    message: "Function 'wrapper' forwards unchanged arguments",
    evidence: ["identity argument mapping"],
    counterEvidence: [],
    unknown: ["dynamic registration cannot be disproven"],
  };
}

function result(root: string, finding: FindingDraft, evidenceRecords: EvidenceRecord[] = []) {
  return createScanResult({
    engine: "provider-federation",
    engineVersion: "test",
    rootDir: root,
    providerId: "test-provider",
    providerVersion: "1",
    providerCapabilities: ["syntax"],
    evidenceRecords,
    scannedFiles: ["input.ts"],
    findings: [finding],
    skipped: [],
  });
}

test("executable rule policies are loaded from the evidence library", () => {
  const policies = loadRulePolicies();
  assert.equal(policies.get("structure.pass-through-wrapper")?.maximumAction, "propose");
  assert.equal(policies.get("data.hidden-catch-fallback")?.risk, "R3");
  assert.equal(policies.get("architecture.disallowed-dependency")?.confidenceCap, "C2");
  assert.match(policies.get("structure.pass-through-wrapper")?.remediationSteps.join(" ") ?? "", /callers/);
  assert.match(policies.get("data.hidden-catch-fallback")?.verificationSteps.join(" ") ?? "", /failure path/);
});

test("policy preserves eligible proposals but caps unregistered rules", () => {
  const { root, state } = fixture();
  const approved = applyPolicy(root, result(root, wrapper()), DEFAULT_CONFIG, state);
  assert.equal(approved.findings[0].maximumAction, "propose");
  assert.equal(approved.policyDecisions[0].evidenceScore, 0.7);

  const unknown = { ...wrapper(), ruleId: "experimental.unregistered" };
  const capped = applyPolicy(root, result(root, unknown), DEFAULT_CONFIG, state);
  assert.equal(capped.findings[0].maximumAction, "observe");
  assert.match(capped.policyDecisions[0].reasons.join(" "), /unregistered/);
});

test("repository counterevidence vetoes a wrapper proposal", () => {
  const { root, state } = fixture();
  const registration: EvidenceRecord = {
    schemaVersion: SCHEMA_VERSION,
    id: fingerprint("evidence", "registration"),
    providerId: "repository-graph",
    providerVersion: "1",
    kind: "reference",
    summary: "framework or runtime registration 'route'",
    strength: "C2",
    source: { filePath: "input.ts", line: 1, column: 1, start: 0, end: 58, sourceHash: "hash" },
  };
  const reviewed = applyPolicy(root, result(root, wrapper(), [registration]), DEFAULT_CONFIG, state);
  assert.equal(reviewed.findings[0].maximumAction, "observe");
  assert.match(reviewed.findings[0].counterEvidence.join(" "), /registration/);
});

test("reasoned suppressions expire, match their scope, and can be removed", () => {
  const { root, state } = fixture();
  const suppression = addSuppression(
    root,
    { ruleId: "structure.pass-through-wrapper", filePath: "input.ts", anchor: "function:wrapper", reason: "audited compatibility boundary" },
    state,
  );
  const suppressed = applyPolicy(root, result(root, wrapper()), DEFAULT_CONFIG, state);
  assert.equal(suppressed.findings.length, 0);
  assert.equal(suppressed.suppressedFindings.length, 1);
  assert.equal(removeSuppression(root, suppression.id, state), true);
  assert.equal(applyPolicy(root, result(root, wrapper()), DEFAULT_CONFIG, state).findings.length, 1);
  assert.throws(() => addSuppression(root, { ruleId: "x", reason: "" }, state), /reason/);
  assert.throws(() => addSuppression(root, { ruleId: "x", reason: "reason", expiresAt: "invalid" }, state), /expiry/);
});

test("feedback health is conservative, privacy-scoped, and disables unsafe rules", () => {
  const { root, state } = fixture();
  const finding = applyPolicy(root, result(root, wrapper()), DEFAULT_CONFIG, state).findings[0] as Finding;
  for (let index = 0; index < 40; index += 1) {
    recordFeedback(root, finding, "accepted", `review ${index}`, ["test-provider"], false, state);
  }
  let reviewed = applyPolicy(root, result(root, wrapper()), DEFAULT_CONFIG, state);
  assert.equal(reviewed.ruleHealth[0].status, "healthy");
  assert.equal(reviewed.ruleHealth[0].selectiveThreshold, 0.7);
  assert.equal(reviewed.ruleHealth[0].conformalThreshold, 0.7);
  assert.equal(reviewed.findings[0].maximumAction, "propose");
  recordFeedback(root, finding, "unsafe-proposal", "behavior changed", ["test-provider"], true, state);
  reviewed = applyPolicy(root, result(root, wrapper()), DEFAULT_CONFIG, state);
  assert.equal(reviewed.ruleHealth[0].status, "disabled");
  assert.equal(reviewed.findings[0].maximumAction, "observe");
  assert.equal(selectiveRiskThreshold([], 0.1), null);
  assert.equal(conformalAcceptanceThreshold([], 0.1), null);
});
