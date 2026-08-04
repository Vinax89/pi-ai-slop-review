import type { AiSlopConfig } from "../core/config.ts";
import { fingerprint } from "../core/schema.ts";
import { StateStore } from "../core/store.ts";
import {
  SCHEMA_VERSION,
  type EvidenceRecord,
  type FeedbackRecord,
  type Finding,
  type FindingConfidence,
  type FindingRisk,
  type MaximumAction,
  type PolicyDecision,
  type RuleHealth,
  type ScanResult,
  type Suppression,
} from "../types.ts";
import { loadRulePolicies, type ExecutableRulePolicy } from "./rules.ts";

const CONFIDENCE_ORDER: Record<FindingConfidence, number> = { C1: 1, C2: 2, C3: 3 };
const ACTION_ORDER: Record<MaximumAction, number> = { ignore: 0, observe: 1, propose: 2, "delegate-safe-fix": 3 };

function capConfidence(value: FindingConfidence, cap: FindingConfidence): FindingConfidence {
  return CONFIDENCE_ORDER[value] <= CONFIDENCE_ORDER[cap] ? value : cap;
}

function capAction(value: MaximumAction, cap: MaximumAction): MaximumAction {
  return ACTION_ORDER[value] <= ACTION_ORDER[cap] ? value : cap;
}

function overlaps(finding: Finding, evidence: EvidenceRecord): boolean {
  if (!evidence.source || evidence.source.filePath !== finding.filePath || evidence.source.sourceHash !== finding.sourceHash) return false;
  return evidence.source.end >= finding.start && evidence.source.start <= finding.end;
}

function contextCounterevidence(finding: Finding, evidence: EvidenceRecord[]): string[] {
  const counter: string[] = [];
  const overlapping = evidence.filter((item) => overlaps(finding, item));
  if (finding.ruleId === "structure.pass-through-wrapper") {
    for (const item of overlapping) {
      if (item.providerId === "repository-graph" && /registration/.test(item.summary)) {
        counter.push(`repository graph found a framework/runtime registration: ${item.summary}`);
      }
    }
    const name = finding.anchor.replace(/^function:/, "");
    for (const item of evidence.filter((entry) => entry.providerId === "repository-graph" && entry.kind === "policy")) {
      const entries = [
        ...(((item.details?.added as unknown[]) ?? []) as Array<Record<string, unknown>>),
        ...(((item.details?.changed as unknown[]) ?? []) as Array<Record<string, unknown>>).map((entry) => (entry.after as Record<string, unknown>) ?? entry),
      ];
      if (entries.some((entry) => String(entry.qualifiedName ?? "").split(".").at(-1) === name)) {
        counter.push("repository public-surface evidence identifies this symbol as exported");
      }
    }
  }
  if (finding.ruleId === "assurance.no-linked-tests") {
    for (const item of evidence.filter((entry) => entry.providerId.startsWith("coverage-") && entry.source?.filePath === finding.filePath)) {
      const missing = Array.isArray(item.details?.missingLines) ? (item.details?.missingLines as number[]) : [];
      if (!missing.includes(finding.line)) counter.push("coverage report executed the finding line even though no static test edge was resolved");
    }
  }
  return counter;
}

function score(finding: Finding): number {
  const base: Record<FindingConfidence, number> = { C1: 0.4, C2: 0.7, C3: 0.95 };
  const counterPenalty = Math.min(0.6, finding.counterEvidence.length * 0.2);
  return Math.max(0, Math.min(1, base[finding.confidence] - counterPenalty));
}

function actionThreshold(risk: Finding["risk"]): number {
  if (risk === "R1") return 0.55;
  if (risk === "R2") return 0.7;
  return 0.9;
}

function activeSuppression(finding: Finding, suppressions: Suppression[], now = Date.now()): Suppression | undefined {
  return suppressions.find((suppression) => {
    if (suppression.ruleId !== finding.ruleId) return false;
    if (suppression.expiresAt && Date.parse(suppression.expiresAt) <= now) return false;
    if (suppression.filePath && suppression.filePath !== finding.filePath) return false;
    if (suppression.anchor && suppression.anchor !== finding.anchor) return false;
    if (suppression.sourceHash && suppression.sourceHash !== finding.sourceHash) return false;
    return true;
  });
}

function wilsonLowerBound(successes: number, total: number, z = 1.96): number | null {
  if (!total) return null;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = proportion + (z * z) / (2 * total);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total);
  return (centre - margin) / denominator;
}

function wilsonUpperBound(successes: number, total: number, z = 1.96): number | null {
  if (!total) return null;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = proportion + (z * z) / (2 * total);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total);
  return (centre + margin) / denominator;
}

export function conformalAcceptanceThreshold(records: FeedbackRecord[], miscoverage = 0.1): number | null {
  const accepted = records.filter((record) => record.outcome === "accepted" && Number.isFinite(record.evidenceScore));
  if (accepted.length < 20 || miscoverage <= 0 || miscoverage >= 1) return null;
  const nonconformity = accepted.map((record) => 1 - record.evidenceScore).sort((left, right) => left - right);
  const index = Math.min(nonconformity.length - 1, Math.ceil((nonconformity.length + 1) * (1 - miscoverage)) - 1);
  return Math.max(0, Math.min(1, 1 - nonconformity[index]));
}

export function selectiveRiskThreshold(records: FeedbackRecord[], maximumError = 0.1): number | null {
  const usable = records.filter((record) => Number.isFinite(record.evidenceScore));
  if (usable.length < 20 || maximumError <= 0 || maximumError >= 1) return null;
  const candidates = [...new Set(usable.map((record) => record.evidenceScore))].sort((left, right) => left - right);
  for (const candidate of candidates) {
    const selected = usable.filter((record) => record.evidenceScore >= candidate);
    if (selected.length < 20) continue;
    const errors = selected.filter((record) => record.outcome !== "accepted" || record.unsafe).length;
    if ((wilsonUpperBound(errors, selected.length) ?? 1) <= maximumError) return candidate;
  }
  return null;
}

export function calculateRuleHealth(feedback: FeedbackRecord[]): RuleHealth[] {
  const groups = new Map<string, FeedbackRecord[]>();
  for (const record of feedback) groups.set(record.ruleId, [...(groups.get(record.ruleId) ?? []), record]);
  return [...groups.entries()].map(([ruleId, records]) => {
    const accepted = records.filter((item) => item.outcome === "accepted").length;
    const rejected = records.length - accepted;
    const unsafeActions = records.filter((item) => item.unsafe).length;
    const lower = wilsonLowerBound(accepted, records.length);
    const selectiveThreshold = selectiveRiskThreshold(records);
    const conformalThreshold = conformalAcceptanceThreshold(records);
    const status: RuleHealth["status"] = unsafeActions
      ? "disabled"
      : records.length < 20
        ? "insufficient-data"
        : (lower ?? 0) >= 0.9
          ? "healthy"
          : "observe-only";
    return {
      ruleId,
      samples: records.length,
      accepted,
      rejected,
      unsafeActions,
      precision: records.length ? accepted / records.length : null,
      wilsonLowerBound: lower,
      selectiveThreshold,
      conformalThreshold,
      status,
    };
  });
}

const RISK_ORDER: Record<FindingRisk, number> = { R1: 1, R2: 2, R3: 3 };

/**
 * Assert that a proposal is authorized by the persisted, complete latest review.
 * This is intentionally strict: callers cannot manufacture authority by supplying
 * finding IDs without the corresponding policy decision and positive evidence.
 */
export function assertProposalAuthority(
  review: ScanResult,
  findingIds: string[],
  proposalRisk: FindingRisk,
  patchPaths: string[] = [],
): void {
  const ids = [...new Set(findingIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) throw new Error("proposal requires at least one latest-review finding ID");
  if (review.completeness?.status !== "complete") throw new Error("proposal authority requires a complete latest review");
  const findings = ids.map((id) => {
    const finding = review.findings.find((item) => item.id === id);
    if (!finding) throw new Error(`finding '${id}' was not found in the latest review`);
    const decision = review.policyDecisions.find((item) => item.findingId === id);
    if (!decision) throw new Error(`policy decision for finding '${id}' was not found in the latest review`);
    return { finding, decision };
  });
  if (patchPaths.length) {
    const authorizedPaths = new Set(findings.map(({ finding }) => finding.filePath));
    const unauthorized = patchPaths.filter((filePath) => !authorizedPaths.has(filePath));
    if (unauthorized.length) throw new Error(`proposal patch paths lack latest-review finding authority: ${unauthorized.join(", ")}`);
  }
  for (const { finding, decision } of findings) {
    if (decision.finalAction === "delegate-safe-fix") {
      if (finding.risk !== "R1" || proposalRisk !== "R1") throw new Error(`finding '${finding.id}' only permits low-risk delegation`);
    } else if (decision.finalAction !== "propose") {
      throw new Error(`finding '${finding.id}' policy action '${decision.finalAction}' does not authorize a proposal`);
    }
    if (RISK_ORDER[proposalRisk] > RISK_ORDER[finding.risk]) {
      throw new Error(`proposal risk ${proposalRisk} exceeds finding '${finding.id}' risk ${finding.risk}`);
    }
    if (!finding.evidence.length || !finding.evidenceIds.length) throw new Error(`finding '${finding.id}' has no positive evidence`);
    if (finding.counterEvidence.length || finding.counterEvidenceIds.length) throw new Error(`finding '${finding.id}' has counterevidence`);
    const positiveEvidence = review.evidenceRecords.filter((record) => finding.evidenceIds.includes(record.id));
    if (positiveEvidence.length !== finding.evidenceIds.length || positiveEvidence.some((record) => record.kind === "counterevidence" || record.kind === "unknown")) {
      throw new Error(`finding '${finding.id}' positive evidence records are unavailable or invalid`);
    }
    const health = review.ruleHealth.find((item) => item.ruleId === finding.ruleId);
    if (health?.status === "observe-only" || health?.status === "disabled") {
      throw new Error(`finding '${finding.id}' local rule health is ${health.status}`);
    }
  }
}

export function applyPolicy(
  rootDir: string,
  input: ScanResult,
  _config: AiSlopConfig,
  stateRoot?: string,
): ScanResult {
  let policies = new Map<string, ExecutableRulePolicy>();
  const store = new StateStore(rootDir, stateRoot);
  let suppressions: Suppression[] = [];
  let health: RuleHealth[] = [];
  let policyStoreDiagnostic: string | undefined;
  try {
    policies = loadRulePolicies();
    const state = store.load();
    suppressions = state.suppressions;
    health = calculateRuleHealth(state.feedback);
  } catch (error) {
    policyStoreDiagnostic = `policy state unavailable; remediation authority remains conservative: ${error instanceof Error ? error.message : String(error)}`;
  }
  const healthByRule = new Map(health.map((item) => [item.ruleId, item]));
  const findings: Finding[] = [];
  const suppressedFindings: Finding[] = [...input.suppressedFindings];
  const decisions: PolicyDecision[] = [...input.policyDecisions];
  for (const original of input.findings) {
    const suppression = activeSuppression(original, suppressions);
    if (suppression) {
      suppressedFindings.push(original);
      decisions.push({
        findingId: original.id,
        originalConfidence: original.confidence,
        finalConfidence: original.confidence,
        originalAction: original.maximumAction,
        finalAction: "ignore",
        evidenceScore: 0,
        reasons: [`suppressed: ${suppression.reason}`],
      });
      continue;
    }
    const discoveredCounterevidence = contextCounterevidence(original, input.evidenceRecords);
    const discoveredCounterevidenceIds = input.evidenceRecords
      .filter((record) => discoveredCounterevidence.some((summary) => summary.includes(record.summary)))
      .map((record) => record.id);
    const finding: Finding = {
      ...original,
      counterEvidence: [...new Set([...original.counterEvidence, ...discoveredCounterevidence])],
      counterEvidenceIds: [...new Set([...original.counterEvidenceIds, ...discoveredCounterevidenceIds])],
    };
    const policy = policies.get(finding.ruleId);
    const originalConfidence = finding.confidence;
    const originalAction = finding.maximumAction;
    const reasons: string[] = [];
    if (!policy) {
      finding.maximumAction = capAction(finding.maximumAction, "observe");
      finding.confidence = capConfidence(finding.confidence, "C2");
      reasons.push("unregistered rules are observation-only and capped at C2");
    } else {
      finding.confidence = capConfidence(finding.confidence, policy.confidenceCap);
      finding.maximumAction = capAction(finding.maximumAction, policy.maximumAction);
      if (policy.risk !== finding.risk) reasons.push(`detector risk ${finding.risk} differs from rule policy ${policy.risk}; stricter effective constraints retained`);
    }
    if (finding.counterEvidence.length) {
      finding.maximumAction = capAction(finding.maximumAction, "observe");
      reasons.push("counterevidence vetoes remediation proposals");
    }
    if (finding.risk === "R3") {
      finding.maximumAction = capAction(finding.maximumAction, "observe");
      reasons.push("R3 findings require manual review");
    }
    const evidenceScore = score(finding);
    const ruleHealth = healthByRule.get(finding.ruleId);
    const calibratedThreshold = Math.max(
      actionThreshold(finding.risk),
      ruleHealth?.selectiveThreshold ?? 0,
      ruleHealth?.conformalThreshold ?? 0,
    );
    if (finding.maximumAction === "propose" && evidenceScore < calibratedThreshold) {
      finding.maximumAction = "observe";
      reasons.push(`evidence score ${evidenceScore.toFixed(2)} is below the calibrated ${calibratedThreshold.toFixed(2)} proposal threshold`);
    }
    if (ruleHealth?.status === "observe-only" || ruleHealth?.status === "disabled") {
      finding.maximumAction = capAction(finding.maximumAction, "observe");
      reasons.push(`rule health is ${ruleHealth.status}`);
    }
    if (evidenceScore < 0.5) {
      finding.confidence = "C1";
      reasons.push("selective prediction reduced confidence because evidence is below 0.50");
    }
    decisions.push({
      findingId: finding.id,
      originalConfidence,
      finalConfidence: finding.confidence,
      originalAction,
      finalAction: finding.maximumAction,
      evidenceScore,
      reasons,
    });
    findings.push(finding);
  }
  if (policyStoreDiagnostic) {
    for (const finding of findings) finding.maximumAction = capAction(finding.maximumAction, "observe");
    for (const decision of decisions) {
      decision.finalAction = capAction(decision.finalAction, "observe");
      decision.reasons.push("policy state unavailable; remediation authority disabled");
    }
  }
  return {
    ...input,
    scanId: fingerprint("scan", {
      inputScanId: input.scanId,
      decisions: decisions.map((decision) => ({
        findingId: decision.findingId,
        confidence: decision.finalConfidence,
        action: decision.finalAction,
        reasons: decision.reasons,
      })),
      suppressed: suppressedFindings.map((finding) => finding.id),
    }),
    findings,
    suppressedFindings,
    policyDecisions: decisions,
    ruleHealth: health,
    skipped: policyStoreDiagnostic
      ? [...input.skipped, { filePath: "<policy-state>", reason: policyStoreDiagnostic, providerId: "policy-engine" }]
      : input.skipped,
  };
}

export function addSuppression(
  rootDir: string,
  input: Omit<Suppression, "schemaVersion" | "id" | "createdAt">,
  stateRoot?: string,
): Suppression {
  if (!input.reason.trim()) throw new Error("suppression reason is required");
  if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt))) throw new Error("suppression expiry must be an ISO date");
  const suppression: Suppression = {
    ...input,
    schemaVersion: SCHEMA_VERSION,
    id: fingerprint("suppression", input),
    createdAt: new Date().toISOString(),
  };
  const store = new StateStore(rootDir, stateRoot);
  store.update((state) => {
    state.suppressions = [...state.suppressions.filter((item) => item.id !== suppression.id), suppression];
  });
  return suppression;
}

export function removeSuppression(rootDir: string, id: string, stateRoot?: string): boolean {
  const store = new StateStore(rootDir, stateRoot);
  let removed = false;
  store.update((state) => {
    const next = state.suppressions.filter((item) => item.id !== id);
    removed = next.length !== state.suppressions.length;
    state.suppressions = next;
  });
  return removed;
}

export function recordFeedback(
  rootDir: string,
  finding: Finding,
  outcome: FeedbackRecord["outcome"],
  reason: string,
  providerIds: string[],
  unsafe = false,
  stateRoot?: string,
): FeedbackRecord {
  if (!reason.trim()) throw new Error("feedback reason is required");
  const store = new StateStore(rootDir, stateRoot);
  const record: FeedbackRecord = {
    schemaVersion: SCHEMA_VERSION,
    id: fingerprint("feedback", { findingId: finding.id, outcome, reason, timestamp: new Date().toISOString() }),
    findingId: finding.id,
    ruleId: finding.ruleId,
    outcome,
    reason,
    createdAt: new Date().toISOString(),
    repositoryId: store.repositoryId,
    findingConfidence: finding.confidence,
    maximumAction: finding.maximumAction,
    providerIds: [...new Set(providerIds)],
    evidenceScore: score(finding),
    unsafe,
  };
  store.update((state) => {
    state.feedback.push(record);
  });
  return record;
}
