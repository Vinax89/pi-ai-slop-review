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
interface CoveragePyParseResult {
  summaries: CoverageSummary[];
  invalid: Array<{ filePath: string; reason: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validLineArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((line) => Number.isSafeInteger(line) && line >= 1);
}

function duplicateLine(lines: number[]): number | undefined {
  const seen = new Set<number>();
  for (const line of lines) {
    if (seen.has(line)) return line;
    seen.add(line);
  }
  return undefined;
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
      const [rawLine, rawCount] = line.slice(3).split(",");
      const lineNumber = Number(rawLine);
      const count = Number(rawCount);
      if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || !Number.isSafeInteger(count) || count < 0) continue;
      total += 1;
      if (count > 0) covered += 1;
      else missing.push(lineNumber);
    } else if (line === "end_of_record") flush();
  }
  flush();
  return summaries;
}

function parseCoveragePy(value: unknown): CoveragePyParseResult {
  const files = isRecord(value) ? value.files : undefined;
  if (!isRecord(files)) throw new Error("coverage.py JSON must contain files");
  const summaries: CoverageSummary[] = [];
  const invalid: Array<{ filePath: string; reason: string }> = [];
  for (const [filePath, raw] of Object.entries(files)) {
    const reject = (reason: string): void => {
      invalid.push({ filePath, reason });
    };
    if (!isRecord(raw)) {
      reject("coverage.py entry is not an object");
      continue;
    }
    if (!validLineArray(raw.executed_lines)) {
      reject("coverage.py entry has invalid executed_lines");
      continue;
    }
    if (!validLineArray(raw.missing_lines)) {
      reject("coverage.py entry has invalid missing_lines");
      continue;
    }
    const duplicateExecuted = duplicateLine(raw.executed_lines);
    const duplicateMissing = duplicateLine(raw.missing_lines);
    if (duplicateExecuted !== undefined || duplicateMissing !== undefined) {
      reject("coverage.py entry has duplicate line values");
      continue;
    }
    const executedSet = new Set(raw.executed_lines);
    const overlap = raw.missing_lines.find((line) => executedSet.has(line));
    if (overlap !== undefined) {
      reject(`coverage.py entry marks line ${overlap} as both executed and missing`);
      continue;
    }
    if (!isRecord(raw.summary)) {
      reject("coverage.py entry has no valid summary");
      continue;
    }
    const totalValue = raw.summary.num_statements;
    const coveredValue = raw.summary.covered_lines;
    if (
      typeof totalValue !== "number" ||
      !Number.isSafeInteger(totalValue) ||
      totalValue < 0 ||
      typeof coveredValue !== "number" ||
      !Number.isSafeInteger(coveredValue) ||
      coveredValue < 0
    ) {
      reject("coverage.py entry has invalid summary values");
      continue;
    }
    const total = totalValue;
    const covered = coveredValue;
    if (covered > total || total !== raw.executed_lines.length + raw.missing_lines.length || covered !== raw.executed_lines.length) {
      reject("coverage.py entry summary is inconsistent with line arrays");
      continue;
    }
    if ("percent_covered" in raw.summary) {
      const percent = raw.summary.percent_covered;
      const expected = total ? (covered / total) * 100 : 100;
      if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100 || Math.abs(percent - expected) > 0.01) {
        reject("coverage.py entry percent_covered is inconsistent with summary");
        continue;
      }
    }
    summaries.push({ filePath, total, covered, missing: raw.missing_lines });
  }
  return { summaries, invalid };
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
      if (descriptor.kind === "lcov") {
        summaries = parseLcov(report.source);
      } else {
        const parsed = parseCoveragePy(JSON.parse(report.source));
        summaries = parsed.summaries;
        skipped.push(
          ...parsed.invalid.map((item) => ({
            filePath: item.filePath,
            reason: item.reason,
            providerId: descriptor.kind,
          })),
        );
      }
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
