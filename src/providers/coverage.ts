import { createScanResult, fingerprint } from "../core/schema.ts";
import type { CoverageReportKind } from "../core/config.ts";
import { SCHEMA_VERSION, type EvidenceRecord, type ScanResult, type SkippedFile } from "../types.ts";
import { safeProjectFile, sourceRange } from "./files.ts";

interface CoverageSummary {
  filePath: string;
  covered: number;
  total: number;
  missing: number[];
}

function parseLcov(source: string): CoverageSummary[] {
  const summaries: CoverageSummary[] = [];
  let filePath = "";
  let covered = 0;
  let total = 0;
  let missing: number[] = [];
  const flush = (): void => {
    if (filePath) summaries.push({ filePath, covered, total, missing });
    filePath = "";
    covered = 0;
    total = 0;
    missing = [];
  };
  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      flush();
      filePath = line.slice(3);
    } else if (line.startsWith("DA:")) {
      const [lineNumber, count] = line.slice(3).split(",").map(Number);
      if (!Number.isFinite(lineNumber) || !Number.isFinite(count)) continue;
      total += 1;
      if (count > 0) covered += 1;
      else missing.push(lineNumber);
    } else if (line === "end_of_record") flush();
  }
  flush();
  return summaries;
}

function parseCoveragePy(value: unknown): CoverageSummary[] {
  const files = (value as any)?.files;
  if (!files || typeof files !== "object") throw new Error("coverage.py JSON must contain files");
  return Object.entries(files).map(([filePath, raw]: [string, any]) => {
    const executed = Array.isArray(raw?.executed_lines) ? raw.executed_lines.filter(Number.isFinite) : [];
    const missing = Array.isArray(raw?.missing_lines) ? raw.missing_lines.filter(Number.isFinite) : [];
    const total = Number(raw?.summary?.num_statements ?? executed.length + missing.length);
    const covered = Number(raw?.summary?.covered_lines ?? executed.length);
    return { filePath, total, covered, missing };
  });
}

export function importCoverageReports(
  rootDir: string,
  reports: Array<{ kind: CoverageReportKind; path: string }>,
): ScanResult {
  const evidenceRecords: EvidenceRecord[] = [];
  const scannedFiles: string[] = [];
  const skipped: SkippedFile[] = [];
  const versions = new Set<string>();
  for (const descriptor of reports) {
    const report = safeProjectFile(rootDir, descriptor.path);
    if (!report) {
      skipped.push({ filePath: descriptor.path, reason: "coverage report is missing or outside the project root", providerId: descriptor.kind });
      continue;
    }
    let summaries: CoverageSummary[];
    try {
      summaries = descriptor.kind === "lcov" ? parseLcov(report.source) : parseCoveragePy(JSON.parse(report.source));
    } catch (error) {
      skipped.push({ filePath: report.filePath, reason: `invalid ${descriptor.kind} report: ${(error as Error).message}`, providerId: descriptor.kind });
      continue;
    }
    versions.add(descriptor.kind);
    for (const summary of summaries) {
      const sourceFile = safeProjectFile(rootDir, summary.filePath);
      if (!sourceFile) {
        skipped.push({ filePath: summary.filePath, reason: `${descriptor.kind} target is missing or outside the project root`, providerId: descriptor.kind });
        continue;
      }
      const percent = summary.total ? (summary.covered / summary.total) * 100 : 100;
      const source = sourceRange(sourceFile.filePath, sourceFile.source, 1, 1, 1, 1);
      const summaryText = `${summary.covered}/${summary.total} executable line(s) covered (${percent.toFixed(1)}%)`;
      evidenceRecords.push({
        schemaVersion: SCHEMA_VERSION,
        id: fingerprint("evidence", { filePath: sourceFile.filePath, kind: descriptor.kind, summaryText }),
        providerId: `coverage-${descriptor.kind}`,
        providerVersion: "1",
        kind: "coverage",
        summary: summaryText,
        strength: "C2",
        source,
        details: { covered: summary.covered, total: summary.total, missingLines: summary.missing },
      });
      scannedFiles.push(sourceFile.filePath);
    }
  }
  return createScanResult({
    engine: "provider-federation",
    engineVersion: versions.size ? [...versions].join(",") : "coverage reports unavailable",
    rootDir,
    providerId: "coverage-reports",
    providerVersion: "1",
    providerCapabilities: ["coverage"],
    evidenceRecords,
    scannedFiles,
    findings: [],
    skipped,
  });
}
