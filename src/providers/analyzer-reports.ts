import { createScanResult } from "../core/schema.ts";
import type { AnalyzerReportKind } from "../core/config.ts";
import type { FindingDraft, ScanResult, SkippedFile } from "../types.ts";
import { safeProjectFile, sourceRange } from "./files.ts";

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

function eslint(value: unknown): NormalizedDiagnostic[] {
  if (!Array.isArray(value)) throw new Error("ESLint report must be an array");
  return value.flatMap((file: any) =>
    Array.isArray(file?.messages)
      ? file.messages.map((message: any) => ({
          filePath: String(file.filePath ?? ""),
          line: Number(message.line ?? 1),
          column: Number(message.column ?? 1),
          endLine: Number(message.endLine ?? message.line ?? 1),
          endColumn: Number(message.endColumn ?? message.column ?? 1),
          rule: String(message.ruleId ?? "parser"),
          message: String(message.message ?? "ESLint diagnostic"),
          severity: Number(message.severity) >= 2 ? "error" : "warning",
          fixAvailable: Boolean(message.fix || Array.isArray(message.suggestions)),
        }))
      : [],
  );
}

function ruff(value: unknown): NormalizedDiagnostic[] {
  if (!Array.isArray(value)) throw new Error("Ruff report must be an array");
  return value.map((item: any) => ({
    filePath: String(item?.filename ?? ""),
    line: Number(item?.location?.row ?? 1),
    column: Number(item?.location?.column ?? 1),
    endLine: Number(item?.end_location?.row ?? item?.location?.row ?? 1),
    endColumn: Number(item?.end_location?.column ?? item?.location?.column ?? 1),
    rule: String(item?.code ?? "ruff"),
    message: String(item?.message ?? "Ruff diagnostic"),
    severity: "warning",
    fixAvailable: Boolean(item?.fix),
  }));
}

function pyright(value: unknown): NormalizedDiagnostic[] {
  const diagnostics = (value as any)?.generalDiagnostics;
  if (!Array.isArray(diagnostics)) throw new Error("Pyright report must contain generalDiagnostics");
  return diagnostics.map((item: any) => ({
    filePath: String(item?.file ?? ""),
    line: Number(item?.range?.start?.line ?? 0) + 1,
    column: Number(item?.range?.start?.character ?? 0) + 1,
    endLine: Number(item?.range?.end?.line ?? item?.range?.start?.line ?? 0) + 1,
    endColumn: Number(item?.range?.end?.character ?? item?.range?.start?.character ?? 0) + 1,
    rule: String(item?.rule ?? "pyright"),
    message: String(item?.message ?? "Pyright diagnostic"),
    severity: item?.severity === "error" ? "error" : item?.severity === "warning" ? "warning" : "note",
  }));
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
        if (!filePath) continue;
        diagnostics.push({
          filePath,
          line: Number(item.line ?? 1),
          column: Number(item.col ?? item.column ?? 1),
          rule: String(item.symbol ?? category),
          message: `Knip reports ${category}${item.symbol ? `: ${String(item.symbol)}` : ""}`,
          severity: "warning",
        });
      }
    }
  }
  return diagnostics;
}

const PARSERS: Record<AnalyzerReportKind, (value: unknown) => NormalizedDiagnostic[]> = { eslint, ruff, pyright, knip };

export function importAnalyzerReports(
  rootDir: string,
  reports: Array<{ kind: AnalyzerReportKind; path: string }>,
): ScanResult {
  const findings: FindingDraft[] = [];
  const scannedFiles: string[] = [];
  const skipped: SkippedFile[] = [];
  const versions = new Set<string>();
  for (const descriptor of reports) {
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
