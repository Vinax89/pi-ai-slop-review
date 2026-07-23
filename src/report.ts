import type { ScanDelta, VerificationStatus } from "./core/ledger.ts";
import { rankFindings, type RankedFinding } from "./core/severity.ts";
import type { ClaimAssessment, LedgerEvent, ScanResult } from "./types.ts";

function formatFinding(item: RankedFinding): string {
  const { finding } = item;
  const header = `${item.severity.toUpperCase()} ${item.score}/100 ${finding.confidence} ${finding.ruleId} ${finding.filePath}:${finding.line}:${finding.column}`;
  const lines = [header, `  ${finding.message}`, ...finding.evidence.map((evidence) => `  evidence: ${evidence}`)];
  for (const item of finding.counterEvidence) lines.push(`  counterevidence: ${item}`);
  for (const item of finding.unknown) lines.push(`  unknown: ${item}`);
  lines.push(`  maximum action: ${finding.maximumAction}`);
  return lines.join("\n");
}

export function formatReport(result: ScanResult, maxFindings = 100): string {
  const shown = rankFindings(result.findings, result.policyDecisions).slice(0, maxFindings);
  const lines = [
    `AI-slop review (read-only): ${result.findings.length} active finding(s), ${result.suppressedFindings.length} suppressed, in ${result.scannedFiles.length} file(s)`,
    `Engine: ${result.engine} ${result.engineVersion}`,
    `Providers: ${result.providers.map((provider) => `${provider.id}@${provider.version}:${provider.status}`).join(", ")}`,
    `Scan: ${result.scanId} (${result.scope.mode}, ${result.scope.contentHash.slice(0, 12)})`,
  ];
  if (shown.length) lines.push("", ...shown.map(formatFinding));
  if (result.findings.length > shown.length) lines.push("", `${result.findings.length - shown.length} finding(s) omitted`);
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

export function formatDelta(delta: ScanDelta): string {
  return `Delta: ${delta.added.length} added, ${delta.changed.length} changed, ${delta.resolved.length} resolved, ${delta.unchanged.length} unchanged`;
}
