import { assessScanCompleteness } from "./core/completeness.ts";
import { assessIntent, type IntentContext } from "./core/intent.ts";
import type { ScanDelta, VerificationStatus } from "./core/ledger.ts";
import { rankFindings, type RankedFinding } from "./core/severity.ts";
import type { ClaimAssessment, LedgerEvent, ScanResult } from "./types.ts";

function triageGuidance(finding: RankedFinding["finding"], finalAction: string, context: IntentContext): string {
  if (finding.risk === "R3") return "Human review required; do not infer that this code is removable.";
  if (finding.confidence === "C1" || finding.counterEvidence.length || finding.unknown.length) {
    return "Evidence is incomplete or contested; inspect intent, callers, tests, and local conventions before acting.";
  }
  if (context.callers || context.tests || context.specifications || context.coverage) {
    return "Repository context shows connected behavior or verification; inspect the existing contract before changing code.";
  }
  if (finalAction === "delegate-safe-fix") return "A narrowly scoped mechanical fix may be appropriate; verify project conventions first.";
  if (finalAction === "propose") return "Proposal only; inspect affected behavior and validate any change before applying it.";
  if (finalAction === "observe") return "Observe and gather context; this finding is not sufficient evidence for a code change.";
  return "No action is recommended from this finding alone.";
}


export function formatTriage(result: ScanResult, maxFindings = 100): string {
  const completeness = result.completeness ?? assessScanCompleteness(result);
  const ranked = rankFindings(result.findings, result.policyDecisions).slice(0, maxFindings);
  const decisions = new Map(result.policyDecisions.map((decision) => [decision.findingId, decision]));
  const actionCounts = new Map<string, number>();
  for (const finding of result.findings) {
    const action = decisions.get(finding.id)?.finalAction ?? finding.maximumAction;
    actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
  }
  const lines = [
    `Intent-aware triage (${completeness.status}): ${result.findings.length} finding(s), ${result.suppressedFindings.length} suppressed`,
    "Findings are evidence for human review, not proof that code is useless or removable.",
    "Context signals inform triage only; they do not prove intent or authorize code removal.",
    `Summary: ${[...actionCounts.entries()].map(([action, count]) => `${count} ${action}`).join(", ") || "no actionable findings"}.`,
    "Start with the highest weighted finding, then review supporting evidence, counterevidence, unknowns, and the suggested verification path.",
  ];
  for (const item of ranked) {
    const decision = decisions.get(item.finding.id);
    const action = decision?.finalAction ?? item.finding.maximumAction;
    const assessment = assessIntent(item.finding, result);
    const context = assessment.context;
    const dimensions = assessment.dimensions.filter((item) => item.status !== "unknown");
    lines.push(
      `${item.finding.id.slice(-8)} REVIEW PRIORITY ${item.score}/100 ${item.finding.ruleId} ${item.finding.filePath}:${item.finding.line}`,
      `  Decision: ${action} (advisory; human approval required)`,
      `  Human review action: ${action}`,
      `  Evidence: ${item.finding.evidence.length} supporting, ${item.finding.counterEvidence.length} counterevidence, ${item.finding.unknown.length} unknown`,
      `  Context: ${context.kinds.join(", ") || "none linked"}; callers=${context.callers} tests=${context.tests} specifications=${context.specifications} coverage=${context.coverage}; completeness=${context.relevantCompleteness}`,
      `  Observed dimensions: ${dimensions.map((item) => `${item.dimension}=${item.status}`).join(", ") || "none"}`,
      `  Guidance: ${triageGuidance(item.finding, action, context)}`,
    );
  }
  if (result.findings.length > ranked.length) lines.push("", `${result.findings.length - ranked.length} finding(s) omitted`);
  return lines.join("\n");
}

function formatFinding(item: RankedFinding, result: ScanResult): string {
  const { finding } = item;
  const header = `REVIEW PRIORITY ${item.score}/100 ${finding.confidence} ${finding.ruleId} ${finding.filePath}:${finding.line}:${finding.column}`;
  const assessment = assessIntent(finding, result);
  const context = assessment.context;
  const dimensions = assessment.dimensions.filter((item) => item.status !== "unknown");
  const lines = [
    header,
    `  Finding: ${finding.message}`,
    "  Supporting evidence:",
    ...(finding.evidence.length ? finding.evidence.map((evidence) => `    - ${evidence}`) : ["    - none linked"]),
    "  Counterevidence:",
    ...(finding.counterEvidence.length ? finding.counterEvidence.map((item) => `    - ${item}`) : ["    - none linked"]),
    "  Unknowns:",
    ...(finding.unknown.length ? finding.unknown.map((item) => `    - ${item}`) : ["    - none recorded"]),
    `  Repository context: ${context.kinds.join(", ") || "none linked"}; callers=${context.callers}, tests=${context.tests}, specifications=${context.specifications}, coverage=${context.coverage}, completeness=${context.relevantCompleteness}`,
    `  Observed dimensions: ${dimensions.map((item) => `${item.dimension}=${item.status}`).join(", ") || "none"}`,
    `  Advisory maximum action: ${finding.maximumAction}`,
    "  Human must decide whether the evidence justifies any change.",
  ];
  return lines.join("\n");
}

export function formatReport(result: ScanResult, maxFindings = 100): string {
  const completeness = result.completeness ?? assessScanCompleteness(result);
  const shown = rankFindings(result.findings, result.policyDecisions).slice(0, maxFindings);
  const decisions = new Map(result.policyDecisions.map((decision) => [decision.findingId, decision]));
  const actionCounts = new Map<string, number>();
  for (const finding of result.findings) {
    const action = decisions.get(finding.id)?.finalAction ?? finding.maximumAction;
    actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
  }
  const lines = [
    `AI-slop review (read-only, ${completeness.status}): ${result.findings.length} active finding(s), ${result.suppressedFindings.length} suppressed, in ${result.scannedFiles.length} file(s)`,
    "HUMAN DECISION SUMMARY",
    "Human decision required: findings are evidence to inspect, not proof that code is useless or removable.",
    `Suggested handling: ${[...actionCounts.entries()].map(([action, count]) => `${count} ${action}`).join(", ") || "none"}. No automatic code change is authorized.`,
    `Engine: ${result.engine} ${result.engineVersion}`,
    `Providers: ${result.providers.map((provider) => `${provider.id}@${provider.version}:${provider.status}`).join(", ") || "none reported"}`,
    `Scan: ${result.scanId} (${result.scope.mode}, ${result.scope.contentHash.slice(0, 12)})`,
  ];
  if (completeness.reasons.length) lines.push(`Completeness: ${completeness.reasons.join("; ")}`);
  if (shown.length) lines.push("", "FINDINGS — highest review priority first", "", ...shown.map((item) => formatFinding(item, result)));
  if (result.findings.length > shown.length) lines.push("", `${result.findings.length - shown.length} finding(s) omitted; increase the display limit to inspect them`);
  if (result.policyDecisions.some((decision) => decision.reasons.length)) {
    lines.push(
      "",
      "Policy decisions:",
      ...result.policyDecisions
        .filter((decision) => decision.reasons.length)
        .slice(0, maxFindings)
        .map((decision) => `  ${decision.findingId}: ${decision.originalAction} → ${decision.finalAction}, score ${decision.evidenceScore.toFixed(2)}; ${decision.reasons.join("; ")}`),
    );
  }
  if (result.ruleHealth.length) {
    lines.push("", "Rule health:", ...result.ruleHealth.map((item) => `  ${item.status} ${item.ruleId}: ${item.accepted}/${item.samples} accepted`));
  }
  if (result.skipped.length) {
    lines.push("", "Skipped:", ...result.skipped.map((item) => `  ${item.providerId ? `${item.providerId}: ` : ""}${item.filePath}: ${item.reason}`));
  }
  return lines.join("\n");
}

export interface FindingQueuePage {
  text: string;
  totalFindings: number;
  queueSize: number;
  offset: number;
  representatives: boolean;
  reportOnlyOmitted: number;
  findings: RankedFinding[];
}

export function createFindingQueue(
  result: ScanResult,
  options: { offset?: number; limit?: number; representatives?: boolean; reportOnly?: readonly string[] } = {},
): FindingQueuePage {
  const ranked = rankFindings(result.findings, result.policyDecisions);
  const reportOnly = new Set(options.reportOnly ?? []);
  const eligible = reportOnly.size ? ranked.filter((item) => !reportOnly.has(item.finding.ruleId)) : ranked;
  const seenRules = new Set<string>();
  const queue = options.representatives
    ? eligible.filter((item) => {
        if (seenRules.has(item.finding.ruleId)) return false;
        seenRules.add(item.finding.ruleId);
        return true;
      })
    : eligible;
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const limit = Math.min(20, Math.max(1, Math.trunc(options.limit ?? 20)));
  const findings = queue.slice(offset, offset + limit);
  const completeness = result.completeness ?? assessScanCompleteness(result);
  const reportOnlyOmitted = ranked.length - eligible.length;
  const lines = [
    "AI-SLOP FINDING QUEUE",
    `Static scan: ${completeness.status} — ${result.scannedFiles.length} files, ${ranked.length} candidates, ${result.skipped.length} skipped`,
    `Queue: ${findings.length} shown from ${queue.length}${options.representatives ? " rule-family representatives" : " ranked candidates"}; offset ${offset}${reportOnlyOmitted ? `; ${reportOnlyOmitted} report-only candidate(s) omitted (${[...reportOnly].join(", ")})` : ""}`,
    ...findings.map((item) => `- ${item.finding.id} | priority ${item.score}/100 | ${item.finding.ruleId} | ${item.finding.filePath}:${item.finding.line}:${item.finding.column}\n  ${item.finding.message}`),
  ];
  if (offset + findings.length < queue.length) lines.push(`Next offset: ${offset + findings.length}`);
  return {
    text: lines.join("\n"),
    totalFindings: ranked.length,
    queueSize: queue.length,
    offset,
    representatives: Boolean(options.representatives),
    reportOnlyOmitted,
    findings,
  };
}

export function formatTimeline(events: LedgerEvent[], statuses: VerificationStatus[]): string {
  const lines = [`Assurance ledger: ${events.length} event(s)`];
  for (const event of events) {
    if (event.kind === "mutation") {
      lines.push(
        `${event.succeeded ? "changed" : "failed"} ${event.filePath} ${event.beforeHash?.slice(0, 8) ?? "missing"} → ${event.afterHash?.slice(0, 8) ?? "missing"} via ${event.toolName}`,
      );
    } else {
      lines.push(
        `${event.succeeded ? "passed" : "failed"} ${event.verificationKind}: ${event.command} (${Object.keys(event.contentHashes).length} hash(es))`,
      );
    }
  }
  if (statuses.length) {
    lines.push("", "Verification freshness:");
    for (const status of statuses) {
      lines.push(
        `  ${status.filePath}: ${status.fresh.length ? `${status.fresh.length} fresh` : "unverified"}${status.stale.length ? `, ${status.stale.length} stale/failed` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatClaims(claims: ClaimAssessment[]): string {
  if (!claims.length) return "No supported claim pattern was found.";
  return claims
    .map((claim) => `${claim.status.toUpperCase()} ${claim.type}: ${claim.claim}\n  ${claim.evidence.join("; ")}`)
    .join("\n");
}


export function formatDelta(delta: ScanDelta, maxFindings = 20): string {
  const lines = [
    `Delta: ${delta.added.length} added, ${delta.changed.length} changed, ${delta.resolved.length} resolved, ${delta.unchanged.length} unchanged`,
  ];
  if (delta.added.length) {
    lines.push("", "New findings:");
    for (const finding of delta.added.slice(0, maxFindings)) {
      lines.push(`  + ${finding.id.slice(-8)} ${finding.risk} ${finding.ruleId} ${finding.filePath}:${finding.line}`);
    }
  }
  if (delta.changed.length) {
    lines.push("", "Changed findings:");
    for (const item of delta.changed.slice(0, maxFindings)) {
      const beforeRisk = item.before.risk === "R3" ? 3 : item.before.risk === "R2" ? 2 : 1;
      const afterRisk = item.after.risk === "R3" ? 3 : item.after.risk === "R2" ? 2 : 1;
      const label = afterRisk > beforeRisk ? "regression candidate" : "evidence changed";
      lines.push(`  ~ ${item.after.id.slice(-8)} ${item.before.risk}→${item.after.risk} ${item.after.ruleId} ${item.after.filePath}:${item.after.line} (${label})`);
    }
  }
  if (delta.resolved.length) {
    lines.push("", "Resolved findings:");
    for (const finding of delta.resolved.slice(0, maxFindings)) {
      lines.push(`  - ${finding.id.slice(-8)} ${finding.risk} ${finding.ruleId} ${finding.filePath}:${finding.line}`);
    }
  }
  const totalListed = Math.min(delta.added.length, maxFindings) + Math.min(delta.changed.length, maxFindings) + Math.min(delta.resolved.length, maxFindings);
  const total = delta.added.length + delta.changed.length + delta.resolved.length;
  if (total > totalListed) lines.push("", `${total - totalListed} delta item(s) omitted`);
  return lines.join("\n");
}

export interface ParsedVerdictLine {
  findingId: string;
  ruleId: string;
  filePath: string;
  line: number;
  text: string;
}

export interface VerdictLineParse {
  verdicts: ParsedVerdictLine[];
  violations: string[];
}

const VERDICT_LINE_PATTERN = /^finding:([0-9a-f]+) \| ([a-z0-9.-]+) \| ([^:]+):(\d+)(?::\d+)? — (.*)$/;

/**
 * Parse skill verdict lines in the `finding ID | rule ID | path:line — text`
 * contract. Structural violations (unparseable lines, duplicate IDs) are
 * reported separately so callers can distinguish format errors from verdicts.
 */
export function parseVerdictLines(lines: string[]): VerdictLineParse {
  const verdicts: ParsedVerdictLine[] = [];
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = VERDICT_LINE_PATTERN.exec(trimmed);
    if (!match) {
      violations.push(`unparseable verdict line: ${trimmed}`);
      continue;
    }
    const findingId = `finding:${match[1]}`;
    if (seen.has(findingId)) violations.push(`duplicate verdict for finding ${findingId}`);
    seen.add(findingId);
    verdicts.push({ findingId, ruleId: match[2], filePath: match[3], line: Number(match[4]), text: match[5] });
  }
  return { verdicts, violations };
}

/**
 * Verify verdict lines against the latest scan result: every ID must exist in
 * the review, rule ID and path:line must match the finding, no duplicates, and
 * the verdict count must equal the adjudicated total when supplied.
 */
export function verifyVerdicts(
  lines: string[],
  result: ScanResult,
  adjudicatedTotal?: number,
): { valid: boolean; violations: string[] } {
  const { verdicts, violations } = parseVerdictLines(lines);
  const byId = new Map(result.findings.map((finding) => [finding.id, finding]));
  for (const verdict of verdicts) {
    const finding = byId.get(verdict.findingId);
    if (!finding) {
      violations.push(`finding ID ${verdict.findingId} is not in the latest review`);
      continue;
    }
    if (finding.ruleId !== verdict.ruleId) {
      violations.push(`finding ${verdict.findingId}: rule ID mismatch (line says ${verdict.ruleId}, review says ${finding.ruleId})`);
    }
    if (finding.filePath !== verdict.filePath || finding.line !== verdict.line) {
      violations.push(`finding ${verdict.findingId}: location mismatch (line says ${verdict.filePath}:${verdict.line}, review says ${finding.filePath}:${finding.line})`);
    }
  }
  if (adjudicatedTotal !== undefined && verdicts.length !== adjudicatedTotal) {
    violations.push(`verdict count ${verdicts.length} does not match adjudicated total ${adjudicatedTotal}`);
  }
  return { valid: violations.length === 0, violations };
}
