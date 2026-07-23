import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isInside, nearestExistingParent } from "./core/paths.ts";
import { canonicalJson } from "./core/schema.ts";
import { StateStore } from "./core/store.ts";
import type { Finding, ScanResult } from "./types.ts";

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
            semanticVersion: "1.0.0",
            rules,
          },
        },
        automationDetails: { id: result.scanId },
        invocations: [{ executionSuccessful: !result.providers.some((provider) => provider.status === "failed") }],
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
        },
      },
    ],
  };
}

export function serializeExport(result: ScanResult, format: "json" | "sarif"): string {
  return `${format === "sarif" ? JSON.stringify(toSarif(result), null, 2) : canonicalJson(result)}\n`;
}

export function writeExport(
  rootDir: string,
  result: ScanResult,
  format: "json" | "sarif",
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
    outputPath = path.join(store.directory, "exports", `${result.scanId.replace(/[^A-Za-z0-9_.-]/g, "-")}.${format === "sarif" ? "sarif.json" : "json"}`);
  }
  mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, serializeExport(result, format), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, outputPath);
  return outputPath;
}
