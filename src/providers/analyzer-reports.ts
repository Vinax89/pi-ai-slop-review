import { createScanResult } from "../core/schema.ts";
import type { AnalyzerReportKind } from "../core/config.ts";
import type { FindingDraft, ScanResult, SkippedFile } from "../types.ts";
import { safeProjectFile, sourceRange, validReportCoordinate } from "./files.ts";

interface NormalizedDiagnostic {
  filePath: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  rule: string;
  message: string;
  severity: "error" | "warning" | "note";
  fixAvailable?: boolean;
}

function coordinate(value: unknown, fallback: unknown = undefined): number {
  if (value === undefined && fallback !== undefined) return coordinate(fallback);
  return typeof value === "number" && Number.isSafeInteger(value) ? value : Number.NaN;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function severity(value: unknown): "error" | "warning" | "note" {
  return value === "error" || value === "warning" || value === "note"
    ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 2
      ? "error"
      : "warning";
}

function eslint(value: unknown): NormalizedDiagnostic[] {
  if (!Array.isArray(value)) throw new Error("ESLint report must be an array");
  return value.flatMap((file: any) =>
    Array.isArray(file?.messages)
      ? file.messages.map((message: any) => ({
          filePath: text(file?.filePath, ""),
          line: coordinate(message?.line),
          column: coordinate(message?.column),
          endLine: coordinate(message?.endLine, message?.line),
          endColumn: coordinate(message?.endColumn, message?.column),
          rule: text(message?.ruleId, "parser"),
          message: text(message?.message, "ESLint diagnostic"),
          severity: severity(message?.severity),
          fixAvailable: Boolean(message?.fix || Array.isArray(message?.suggestions)),
        }))
      : [],
  );
}

function ruff(value: unknown): NormalizedDiagnostic[] {
  if (!Array.isArray(value)) throw new Error("Ruff report must be an array");
  return value.map((item: any) => {
    const location = item?.location;
    const endLocation = item?.end_location;
    return {
      filePath: text(item?.filename, ""),
      line: coordinate(location?.row),
      column: coordinate(location?.column),
      endLine: coordinate(endLocation?.row, location?.row),
      endColumn: coordinate(endLocation?.column, location?.column),
      rule: text(item?.code, "ruff"),
      message: text(item?.message, "Ruff diagnostic"),
      severity: "warning",
      fixAvailable: Boolean(item?.fix),
    };
  });
}

function pyright(value: unknown): NormalizedDiagnostic[] {
  const diagnostics = (value as any)?.generalDiagnostics;
  if (!Array.isArray(diagnostics)) throw new Error("Pyright report must contain generalDiagnostics");
  return diagnostics.map((item: any) => {
    const start = item?.range?.start;
    const end = item?.range?.end;
    return {
      filePath: text(item?.file, ""),
      line: coordinate(typeof start?.line === "number" ? start.line + 1 : Number.NaN),
      column: coordinate(typeof start?.character === "number" ? start.character + 1 : Number.NaN),
      endLine: coordinate(typeof end?.line === "number" ? end.line + 1 : Number.NaN, typeof start?.line === "number" ? start.line + 1 : Number.NaN),
      endColumn: coordinate(typeof end?.character === "number" ? end.character + 1 : Number.NaN, typeof start?.character === "number" ? start.character + 1 : Number.NaN),
      rule: text(item?.rule, "pyright"),
      message: text(item?.message, "Pyright diagnostic"),
      severity: item?.severity === "error" ? "error" : item?.severity === "warning" ? "warning" : "note",
    };
  });
}

function knip(value: unknown): NormalizedDiagnostic[] {
  const diagnostics: NormalizedDiagnostic[] = [];
  const document = value as Record<string, unknown>;
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Knip report must be an object");
  for (const [category, entries] of Object.entries(document)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry === "string") {
        diagnostics.push({ filePath: entry, line: 1, column: 1, rule: category, message: `Knip reports ${category}: ${entry}`, severity: "warning" });
      } else if (entry && typeof entry === "object") {
        const item = entry as Record<string, unknown>;
        const filePath = typeof item.file === "string" ? item.file : typeof item.path === "string" ? item.path : "";
        const symbol = typeof item.symbol === "string" ? item.symbol : undefined;
        if (!filePath) {
          diagnostics.push({ filePath: "", line: Number.NaN, column: Number.NaN, rule: category, message: `Knip reports malformed ${category} record`, severity: "warning" });
          continue;
        }
        diagnostics.push({
          filePath,
          line: coordinate(item.line, 1),
          column: coordinate(item.col ?? item.column, 1),
          rule: symbol ?? category,
          message: `Knip reports ${category}${symbol ? `: ${symbol}` : ""}`,
          severity: "warning",
        });
      } else {
        diagnostics.push({ filePath: "", line: Number.NaN, column: Number.NaN, rule: category, message: `Knip reports malformed ${category} record`, severity: "warning" });
      }
    }
  }
  return diagnostics;
}

const PARSERS: Record<AnalyzerReportKind, (value: unknown) => NormalizedDiagnostic[]> = { eslint, ruff, pyright, knip };

export function importAnalyzerReports(
  rootDir: string,
  reports: Array<{ kind: AnalyzerReportKind; path: string }>,
  maxFindings = Number.POSITIVE_INFINITY,
): ScanResult {
  const findings: FindingDraft[] = [];
  const scannedFiles: string[] = [];
  const skipped: SkippedFile[] = [];
  const versions = new Set<string>();
  for (const descriptor of reports) {
    if (findings.length >= maxFindings) break;
    const report = safeProjectFile(rootDir, descriptor.path);
    if (!report) {
      skipped.push({ filePath: descriptor.path, reason: "analyzer report is missing or outside the project root", providerId: descriptor.kind });
      continue;
    }
    let diagnostics: NormalizedDiagnostic[];
    try {
      diagnostics = PARSERS[descriptor.kind](JSON.parse(report.source));
    } catch (error) {
      skipped.push({ filePath: report.filePath, reason: `invalid ${descriptor.kind} report: ${(error as Error).message}`, providerId: descriptor.kind });
      continue;
    }
    versions.add(descriptor.kind);
    for (const diagnostic of diagnostics) {
      if (findings.length >= maxFindings) break;
      if (
        !validReportCoordinate(diagnostic.line) ||
        !validReportCoordinate(diagnostic.column) ||
        (diagnostic.endLine !== undefined && !validReportCoordinate(diagnostic.endLine)) ||
        (diagnostic.endColumn !== undefined && !validReportCoordinate(diagnostic.endColumn))
      ) {
        skipped.push({
          filePath: diagnostic.filePath || report.filePath,
          reason: `${descriptor.kind} diagnostic has invalid non-finite or non-integral coordinates`,
          providerId: descriptor.kind,
        });
        continue;
      }
      const sourceFile = safeProjectFile(rootDir, diagnostic.filePath);
      if (!sourceFile) {
        skipped.push({ filePath: diagnostic.filePath, reason: `${descriptor.kind} diagnostic target is missing or outside the project root`, providerId: descriptor.kind });
        continue;
      }
      const range = sourceRange(
        sourceFile.filePath,
        sourceFile.source,
        diagnostic.line,
        diagnostic.column,
        diagnostic.endLine,
        diagnostic.endColumn,
      );
      findings.push({
        ...range,
        anchor: `${descriptor.kind}:${diagnostic.rule}:${diagnostic.message}`,
        ruleId: `analyzer.${descriptor.kind}.${diagnostic.rule}`,
        classification: diagnostic.severity === "error" ? "defect" : diagnostic.severity === "warning" ? "context_conflict" : "assurance_gap",
        confidence: diagnostic.severity === "error" ? "C2" : "C1",
        risk: diagnostic.severity === "error" ? "R2" : "R1",
        maximumAction: "observe",
        message: diagnostic.message,
        evidence: [
          `${descriptor.kind} emitted a structured ${diagnostic.severity} diagnostic`,
          ...(diagnostic.fixAvailable ? ["upstream fix is available but was not applied"] : []),
        ],
        counterEvidence: [],
        unknown: ["analyzer configuration and repository-specific intent may affect this diagnostic"],
      });
      scannedFiles.push(sourceFile.filePath);
    }
  }
  return createScanResult({
    engine: "provider-federation",
    engineVersion: versions.size ? [...versions].join(",") : "analyzer reports unavailable",
    rootDir,
    providerId: "analyzer-reports",
    providerVersion: "1",
    providerCapabilities: ["diagnostics", "types", "references", "dependencies"],
    scannedFiles,
    findings,
    skipped,
  });
}
