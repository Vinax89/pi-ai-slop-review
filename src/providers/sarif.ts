import path from "node:path";

import { createScanResult } from "../core/schema.ts";
import type { FindingConfidence, FindingDraft, FindingRisk, ScanResult, SkippedFile } from "../types.ts";
import { safeProjectFile, sourceRange, validReportCoordinate } from "./files.ts";

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string; uriBaseId?: string };
    region?: { startLine?: number; startColumn?: number; endLine?: number; endColumn?: number };
  };
}

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string; markdown?: string };
  locations?: SarifLocation[];
  codeFlows?: unknown[];
  fixes?: unknown[];
  suppressions?: unknown[];
}

interface SarifRun {
  tool?: { driver?: { name?: string; semanticVersion?: string; version?: string } };
  originalUriBaseIds?: Record<string, { uri?: string }>;
  results?: SarifResult[];
}

interface SarifDocument {
  version?: string;
  runs?: SarifRun[];
}

function levelPolicy(level: string | undefined): {
  classification: FindingDraft["classification"];
  confidence: FindingConfidence;
  risk: FindingRisk;
} {
  if (level === "error") return { classification: "defect", confidence: "C2", risk: "R2" };
  if (level === "warning") return { classification: "context_conflict", confidence: "C2", risk: "R2" };
  return { classification: "assurance_gap", confidence: "C1", risk: "R1" };
}

function artifactPath(run: SarifRun, location: SarifLocation): string | undefined {
  const artifact = location.physicalLocation?.artifactLocation;
  if (!artifact?.uri) return undefined;
  const base = artifact.uriBaseId ? run.originalUriBaseIds?.[artifact.uriBaseId]?.uri : undefined;
  try {
    if (!base) return decodeURIComponent(artifact.uri);
    return decodeURIComponent(new URL(artifact.uri, base).toString());
  } catch {
    return base ? path.join(base, artifact.uri) : artifact.uri;
  }
}

export function importSarif(rootDir: string, reportPaths: string[]): ScanResult {
  const findings: FindingDraft[] = [];
  const skipped: SkippedFile[] = [];
  const scannedFiles: string[] = [];
  const versions = new Set<string>();

  for (const reportPath of reportPaths) {
    const report = safeProjectFile(rootDir, reportPath);
    if (!report) {
      skipped.push({ filePath: reportPath, reason: "SARIF report is missing or outside the project root", providerId: "sarif" });
      continue;
    }
    let document: SarifDocument;
    try {
      document = JSON.parse(report.source) as SarifDocument;
    } catch (error) {
      skipped.push({ filePath: report.filePath, reason: `invalid SARIF JSON: ${(error as Error).message}`, providerId: "sarif" });
      continue;
    }
    if (document.version !== "2.1.0" || !Array.isArray(document.runs)) {
      skipped.push({ filePath: report.filePath, reason: "unsupported SARIF document; expected version 2.1.0 runs", providerId: "sarif" });
      continue;
    }
    versions.add(document.version);
    for (const run of document.runs) {
      const toolName = run.tool?.driver?.name ?? "unknown-tool";
      const toolVersion = run.tool?.driver?.semanticVersion ?? run.tool?.driver?.version ?? "unknown";
      for (const result of run.results ?? []) {
        const location = result.locations?.[0];
        const rawArtifact = location ? artifactPath(run, location) : undefined;
        const sourceFile = rawArtifact ? safeProjectFile(rootDir, rawArtifact) : undefined;
        if (!sourceFile) {
          skipped.push({
            filePath: rawArtifact ?? report.filePath,
            reason: `SARIF ${toolName} result has no readable in-project primary location`,
            providerId: "sarif",
          });
          continue;
        }
        const region = location?.physicalLocation?.region;
        const coordinates = [region?.startLine, region?.startColumn, region?.endLine, region?.endColumn];
        if (coordinates.some((coordinate) => coordinate !== undefined && !validReportCoordinate(coordinate))) {
          skipped.push({
            filePath: rawArtifact ?? report.filePath,
            reason: `SARIF ${toolName} result has invalid non-finite or non-integral coordinates`,
            providerId: "sarif",
          });
          continue;
        }
        const range = sourceRange(
          sourceFile.filePath,
          sourceFile.source,
          region?.startLine,
          region?.startColumn,
          region?.endLine ?? region?.startLine,
          region?.endColumn ?? region?.startColumn,
        );
        const ruleId = result.ruleId ?? "unidentified";
        const message = result.message?.text ?? result.message?.markdown ?? "SARIF result without a message";
        const policy = levelPolicy(result.level);
        const evidence = [
          `${toolName} ${toolVersion} emitted SARIF level ${result.level ?? "none"}`,
          ...(result.codeFlows?.length ? [`${result.codeFlows.length} SARIF code flow(s) are available`] : []),
          ...(result.fixes?.length ? [`${result.fixes.length} upstream fix suggestion(s) retained as evidence only`] : []),
        ];
        const counterEvidence = result.suppressions?.length ? ["SARIF result contains a suppression record"] : [];
        findings.push({
          ...range,
          anchor: `sarif:${toolName}:${ruleId}:${message}`,
          ruleId: `sarif.${toolName.replace(/[^A-Za-z0-9_.-]+/g, "-")}.${ruleId}`,
          ...policy,
          maximumAction: "observe",
          message,
          evidence,
          counterEvidence,
          unknown: ["upstream analyzer configuration and repository-specific intent may affect this result"],
        });
        scannedFiles.push(sourceFile.filePath);
      }
    }
  }

  return createScanResult({
    engine: "provider-federation",
    engineVersion: versions.size ? `SARIF ${[...versions].join(",")}` : "SARIF unavailable",
    rootDir,
    providerId: "sarif",
    providerVersion: versions.size ? [...versions].join(",") : "unknown",
    providerCapabilities: ["diagnostics", "control-flow", "data-flow"],
    scannedFiles,
    findings,
    skipped,
  });
}
