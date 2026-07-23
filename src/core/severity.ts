import type { Finding, PolicyDecision } from "../types.ts";

export type Severity = "Critical" | "High" | "Medium" | "Low";

export interface RankedFinding {
  finding: Finding;
  decision?: PolicyDecision;
  score: number;
  severity: Severity;
  evidenceScore: number;
}

export const SEVERITIES: Severity[] = ["Critical", "High", "Medium", "Low"];

const RISK_WEIGHT: Record<Finding["risk"], number> = { R1: 1, R2: 2, R3: 3 };
const CONFIDENCE_WEIGHT: Record<Finding["confidence"], number> = { C1: 1, C2: 2, C3: 3 };
const DEFAULT_EVIDENCE_SCORE: Record<Finding["confidence"], number> = { C1: 0.4, C2: 0.7, C3: 0.95 };

export function weightedSeverity(finding: Finding, decision?: PolicyDecision): Omit<RankedFinding, "finding" | "decision"> {
  const evidenceScore = Math.max(0, Math.min(1, decision?.evidenceScore ?? DEFAULT_EVIDENCE_SCORE[finding.confidence]));
  const score = Math.round(100 * (
    0.6 * (RISK_WEIGHT[finding.risk] / 3) +
    0.25 * (CONFIDENCE_WEIGHT[finding.confidence] / 3) +
    0.15 * evidenceScore
  ));
  const severity: Severity = score >= 85 ? "Critical" : score >= 65 ? "High" : score >= 40 ? "Medium" : "Low";
  return { score, severity, evidenceScore };
}

export function rankFindings(findings: Finding[], policyDecisions: PolicyDecision[]): RankedFinding[] {
  const decisions = new Map(policyDecisions.map((decision) => [decision.findingId, decision]));
  return findings.map((finding) => ({
    finding,
    decision: decisions.get(finding.id),
    ...weightedSeverity(finding, decisions.get(finding.id)),
  })).sort((left, right) =>
    right.score - left.score ||
    left.finding.filePath.localeCompare(right.finding.filePath) ||
    left.finding.line - right.finding.line ||
    left.finding.ruleId.localeCompare(right.finding.ruleId) ||
    left.finding.id.localeCompare(right.finding.id),
  );
}
