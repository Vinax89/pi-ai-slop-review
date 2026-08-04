import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assessScanCompleteness } from "./core/completeness.ts";
import { isInside, nearestExistingParent } from "./core/paths.ts";
import { canonicalJson } from "./core/schema.ts";
import { rankFindings, SEVERITIES } from "./core/severity.ts";
import { StateStore } from "./core/store.ts";
import { loadRulePolicies, type ExecutableRulePolicy } from "./policy/rules.ts";
import type { Finding, ScanResult } from "./types.ts";

export type ExportFormat = "json" | "sarif" | "markdown";

const PACKAGE_VERSION = String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);

function sarifLevel(finding: Finding): "error" | "warning" | "note" {
  if (finding.classification === "defect" && finding.confidence !== "C1") return "error";
  if (finding.confidence === "C1") return "note";
  return "warning";
}

function sarifResult(finding: Finding, suppressed = false): Record<string, unknown> {
  return {
    ruleId: finding.ruleId,
    level: sarifLevel(finding),
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: finding.filePath },
          region: {
            startLine: finding.line,
            startColumn: finding.column,
            charOffset: finding.start,
            charLength: Math.max(0, finding.end - finding.start),
          },
        },
      },
    ],
    suppressions: suppressed ? [{ kind: "external", status: "accepted", justification: "Suppressed by repository/user policy" }] : undefined,
    properties: {
      findingId: finding.id,
      anchor: finding.anchor,
      classification: finding.classification,
      confidence: finding.confidence,
      risk: finding.risk,
      maximumAction: finding.maximumAction,
      sourceHash: finding.sourceHash,
      evidence: finding.evidence,
      counterEvidence: finding.counterEvidence,
      unknown: finding.unknown,
    },
  };
}

export function toSarif(result: ScanResult): Record<string, unknown> {
  const completeness = result.completeness ?? assessScanCompleteness(result);
  const all = [...result.findings, ...result.suppressedFindings];
  const rules = [...new Set(all.map((finding) => finding.ruleId))].sort().map((ruleId) => ({
    id: ruleId,
    name: ruleId,
    shortDescription: { text: ruleId },
  }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Pi AI-Slop Review",
            semanticVersion: PACKAGE_VERSION,
            rules,
          },
        },
        automationDetails: { id: result.scanId },
        invocations: [{ executionSuccessful: completeness.status === "complete" }],
        results: [
          ...result.findings.map((finding) => sarifResult(finding)),
          ...result.suppressedFindings.map((finding) => sarifResult(finding, true)),
        ],
        properties: {
          schemaVersion: result.schemaVersion,
          generatedAt: result.generatedAt,
          scope: result.scope,
          providers: result.providers,
          policyDecisions: result.policyDecisions,
          ruleHealth: result.ruleHealth,
          completeness,
        },
      },
    ],
  };
}

function markdownText(value: unknown): string {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replace(/[\\`*_\[\]~]/g, "\\$&");
}

function findingList(title: string, values: string[]): string[] {
  return values.length ? [`#### ${title}`, ...values.map((value) => `- ${markdownText(value)}`), ""] : [];
}

function remediationFor(finding: Finding, policy?: ExecutableRulePolicy): { possible: string[]; verification: string[] } {
  const possible = ["Confirm the finding against the current source hash and repository context before changing code."];
  if (finding.counterEvidence.length || finding.unknown.length) {
    possible.push("Resolve the listed counterevidence and unknowns before selecting a remediation.");
  }
  possible.push(...(policy?.remediationSteps.length ? policy.remediationSteps : ["Inspect callers and contracts, then make the smallest change that addresses the reported behavior."]));
  if (finding.risk === "R3") possible.push("Require manual review for this R3 finding; do not generate or apply an automatic patch.");
  if (finding.maximumAction === "ignore") possible.push("Do not remediate while policy marks this finding as ignored or suppressed.");
  else if (finding.maximumAction === "observe") possible.push("Treat these as investigation steps only; current policy does not authorize an automatic patch.");
  else if (finding.maximumAction === "propose") possible.push("Draft the smallest patch as a proposal, then validate it in isolated baseline and candidate worktrees before explicit application.");
  else possible.push("Use only an authoritative analyzer's released fix, then validate it before explicit application.");
  const verification = [
    ...(policy?.verificationSteps.length ? policy.verificationSteps : ["Run the smallest test or static check that proves the affected behavior."]),
    "Re-run AI-slop review and confirm the finding is resolved without introducing new findings.",
  ];
  return { possible: [...new Set(possible)], verification: [...new Set(verification)] };
}

export function toMarkdown(result: ScanResult): string {
  const completeness = result.completeness ?? assessScanCompleteness(result);
  const rulePolicies = loadRulePolicies();
  const evidenceProviders = new Map(result.evidenceRecords.map((evidence) => [evidence.id, evidence.providerId]));
  const ranked = rankFindings(result.findings, result.policyDecisions);
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, ranked.filter((item) => item.severity === severity).length]));
  const lines = [
    "# AI-Slop Findings Report",
    "",
    "> Weighted severity is a presentation priority only. Possible remediation is advisory and does not authorize automatic changes.",
    "",
    "## Scan Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Scan ID | ${markdownText(result.scanId)} |`,
    `| Generated | ${markdownText(result.generatedAt)} |`,
    `| Scope | ${markdownText(result.scope.mode)} |`,
    `| Files scanned | ${result.scannedFiles.length} |`,
    `| Active findings | ${result.findings.length} |`,
    `| Suppressed findings | ${result.suppressedFindings.length} |`,
    `| Skipped files | ${result.skipped.length} |`,
    `| Completeness | ${markdownText(completeness.status)} |`,
    "",
    "## Weighted Severity",
    "",
    "Score = 60% risk + 25% confidence + 15% policy evidence. Findings are sorted by score, then source location.",
    "",
    "| Severity | Score | Findings |",
    "| --- | ---: | ---: |",
    `| Critical | 85–100 | ${counts.Critical} |`,
    `| High | 65–84 | ${counts.High} |`,
    `| Medium | 40–64 | ${counts.Medium} |`,
    `| Low | 0–39 | ${counts.Low} |`,
    "",
    "## Provider Health",
    "",
    "| Provider | Status | Version | Duration | Diagnostic |",
    "| --- | --- | --- | ---: | --- |",
    ...result.providers.map((provider) => `| ${markdownText(provider.id)} | ${provider.status} | ${markdownText(provider.version)} | ${provider.durationMs ?? "—"} | ${markdownText(provider.diagnostic ?? "")} |`),
    "",
  ];

  if (completeness.reasons.length) {
    lines.push("> **Incomplete review:** This result must not be interpreted as a clean scan.", "", ...completeness.reasons.map((reason) => `- ${markdownText(reason)}`), "");
  }
  if (!ranked.length) lines.push("## Findings", "", "_No active findings._", "");
  let findingNumber = 0;
  for (const severity of SEVERITIES) {
    const findings = ranked.filter((item) => item.severity === severity);
    if (!findings.length) continue;
    lines.push(`## ${severity} Findings (${findings.length})`, "");
    for (const item of findings) {
      findingNumber += 1;
      const { finding, decision } = item;
      const providers = [...new Set(finding.evidenceIds.map((id) => evidenceProviders.get(id)).filter((value): value is string => Boolean(value)))];
      const remediation = remediationFor(finding, rulePolicies.get(finding.ruleId));
      lines.push(
        `### ${findingNumber}. ${markdownText(finding.ruleId)} — ${markdownText(finding.message)}`,
        "",
        `- **Weighted severity:** ${item.severity} (${item.score}/100)`,
        `- **Risk / confidence / evidence:** ${finding.risk} / ${finding.confidence} / ${item.evidenceScore.toFixed(2)}`,
        `- **Classification:** ${markdownText(finding.classification)}`,
        `- **Maximum action:** ${markdownText(finding.maximumAction)}`,
        `- **Location:** ${markdownText(finding.filePath)}:${finding.line}:${finding.column} (offsets ${finding.start}–${finding.end})`,
        `- **Finding ID:** ${markdownText(finding.id)}`,
        `- **Anchor:** ${markdownText(finding.anchor)}`,
        `- **Source hash:** ${markdownText(finding.sourceHash)}`,
        `- **Providers:** ${providers.length ? providers.map(markdownText).join(", ") : "detector only"}`,
        "",
        ...findingList("Evidence", finding.evidence),
        ...findingList("Counterevidence", finding.counterEvidence),
        ...findingList("Unknowns", finding.unknown),
        ...findingList("Policy Notes", decision?.reasons ?? []),
        ...findingList("Possible Remediation", remediation.possible),
        ...findingList("Suggested Verification", remediation.verification),
      );
    }
  }

  if (result.suppressedFindings.length) {
    lines.push("## Suppressed Findings", "", "| Rule | Location | Message |", "| --- | --- | --- |");
    for (const finding of result.suppressedFindings) {
      lines.push(`| ${markdownText(finding.ruleId)} | ${markdownText(finding.filePath)}:${finding.line}:${finding.column} | ${markdownText(finding.message)} |`);
    }
    lines.push("");
  }
  if (result.ruleHealth.length) {
    lines.push("## Rule Health", "", "| Rule | Status | Accepted / Samples | Precision | Threshold |", "| --- | --- | ---: | ---: | ---: |");
    for (const health of result.ruleHealth) {
      lines.push(`| ${markdownText(health.ruleId)} | ${health.status} | ${health.accepted} / ${health.samples} | ${health.precision?.toFixed(2) ?? "—"} | ${health.selectiveThreshold?.toFixed(2) ?? "—"} |`);
    }
    lines.push("");
  }
  if (result.skipped.length) {
    lines.push("## Skipped Files", "", "| File | Provider | Reason |", "| --- | --- | --- |");
    for (const skipped of result.skipped) {
      lines.push(`| ${markdownText(skipped.filePath)} | ${markdownText(skipped.providerId ?? "native")} | ${markdownText(skipped.reason)} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function serializeExport(result: ScanResult, format: ExportFormat): string {
  if (format === "markdown") return toMarkdown(result);
  return `${format === "sarif" ? JSON.stringify(toSarif(result), null, 2) : canonicalJson(result)}\n`;
}

export function writeExport(
  rootDir: string,
  result: ScanResult,
  format: ExportFormat,
  requestedPath?: string,
  stateRoot?: string,
): string {
  let outputPath: string;
  if (requestedPath) {
    const root = realpathSync(rootDir);
    outputPath = path.resolve(root, requestedPath);
    if (!isInside(root, outputPath) || !isInside(root, realpathSync(nearestExistingParent(outputPath)))) {
      throw new Error("export path resolves outside the project root");
    }
  } else {
    const store = new StateStore(rootDir, stateRoot);
    const extension = format === "sarif" ? "sarif.json" : format === "markdown" ? "md" : "json";
    outputPath = path.join(store.directory, "exports", `${result.scanId.replace(/[^A-Za-z0-9_.-]/g, "-")}.${extension}`);
  }
  mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  const cleanupTemporary = (): void => {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original export failure if cleanup itself is unavailable.
    }
  };
  let descriptor: number | undefined;
  try {
    const opened = openSync(temporaryPath, "wx", 0o600);
    descriptor = opened;
    try {
      writeFileSync(opened, serializeExport(result, format), "utf8");
    } finally {
      closeSync(opened);
      descriptor = undefined;
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The original write/close failure is more useful to callers.
      }
    }
    cleanupTemporary();
    throw error;
  }
  try {
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    cleanupTemporary();
    throw error;
  }
  return outputPath;
}
