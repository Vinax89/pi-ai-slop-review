import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import { realpathSync } from "node:fs";

import { isInside, normalizePath } from "./core/paths.ts";
import { createScanResult } from "./core/schema.ts";
import type { FindingDraft, ScanResult, SkippedFile } from "./types.ts";

interface PythonHelperResult {
  engineVersion: string;
  scannedFiles: string[];
  findings: FindingDraft[];
  skipped: SkippedFile[];
}

export interface PythonScanOptions {
  maxFileBytes?: number;
  maxOutputBytes?: number;
  commandTimeoutMs?: number;
  maxFindings?: number;
}
function validateHelperResult(rootDir: string, requestedPaths: string[], value: unknown): PythonHelperResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Python AST helper returned a non-object JSON value");
  const document = value as Record<string, unknown>;
  if (typeof document.engineVersion !== "string" || !Array.isArray(document.scannedFiles) || !Array.isArray(document.findings) || !Array.isArray(document.skipped)) {
    throw new Error("Python AST helper JSON has an invalid shape");
  }
  const root = realpathSync(rootDir);
  const requested = new Set(requestedPaths.map((filePath) => normalizePath(filePath.replace(/^@/, ""))));
  const validatePath = (rawPath: unknown): string => {
    if (typeof rawPath !== "string" || rawPath.startsWith("<")) throw new Error("Python AST helper returned an invalid path");
    const filePath = normalizePath(rawPath);
    const absolute = path.resolve(root, filePath);
    if (path.isAbsolute(rawPath) || !requested.has(filePath) || !isInside(root, absolute)) throw new Error(`Python AST helper returned an invalid path: ${String(rawPath)}`);
    return filePath;
  };
  const scannedFiles = document.scannedFiles.map(validatePath);
  const skipped = document.skipped.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Python AST helper returned a malformed skipped item");
    const candidate = item as Record<string, unknown>;
    const filePath = validatePath(candidate.filePath);
    if (typeof candidate.reason !== "string") throw new Error(`Python AST helper returned a malformed skip reason: ${filePath}`);
    return { filePath, reason: candidate.reason };
  });
  const findings = document.findings.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Python AST helper returned a malformed finding");
    const candidate = item as Record<string, unknown>;
    const filePath = validatePath(candidate.filePath);
    for (const key of ["line", "column", "start", "end"]) {
      if (typeof candidate[key] !== "number" || !Number.isSafeInteger(candidate[key]) || candidate[key] < 0) throw new Error(`Python AST helper returned invalid coordinates: ${filePath}`);
    }
    return item as FindingDraft;
  });
  const accounted = new Set([...scannedFiles, ...skipped.map((item) => item.filePath)]);
  for (const filePath of requested) {
    if (!accounted.has(filePath)) skipped.push({ filePath, reason: "Python AST helper omitted this requested path" });
  }
  return { engineVersion: document.engineVersion, scannedFiles, findings, skipped };
}

const execFileAsync = promisify(execFile);
const HELPER_PATH = fileURLToPath(new URL("./python_helper.py", import.meta.url));
const PYTHON_BATCH_SIZE = 500;
const PYTHON_BATCH_CONCURRENCY = 4;

export async function scanPythonFiles(rootDir: string, paths: string[], signal?: AbortSignal, options: PythonScanOptions = {}): Promise<ScanResult> {
  if (!paths.length) {
    return createScanResult({
      engine: "python-ast",
      engineVersion: "unknown",
      rootDir,
      providerId: "python-ast",
      providerVersion: "unknown",
      providerCapabilities: ["syntax", "resolution", "control-flow"],
      scannedFiles: [],
      findings: [],
      skipped: [],
    });
  }
  const batches = Array.from({ length: Math.ceil(paths.length / PYTHON_BATCH_SIZE) }, (_, index) =>
    paths.slice(index * PYTHON_BATCH_SIZE, (index + 1) * PYTHON_BATCH_SIZE));
  const outputs = new Array<PythonHelperResult>(batches.length);
  let nextBatch = 0;
  const worker = async (): Promise<void> => {
    while (nextBatch < batches.length) {
      const index = nextBatch;
      nextBatch += 1;
      const batch = batches[index];
      if (signal?.aborted) {
        outputs[index] = { engineVersion: "unknown", scannedFiles: [], findings: [], skipped: batch.map((filePath) => ({ filePath, reason: "Python AST scan aborted" })) };
        continue;
      }
      try {
        const { stdout } = await execFileAsync(
          process.env.PI_AI_SLOP_PYTHON ?? "python3",
          ["-I", "-S", HELPER_PATH, rootDir, ...batch],
          {
            encoding: "utf8",
            maxBuffer: options.maxOutputBytes ?? 5 * 1024 * 1024,
            timeout: options.commandTimeoutMs ?? 120_000,
            signal,
            env: { ...process.env, PI_AI_SLOP_MAX_FILE_BYTES: String(options.maxFileBytes ?? 1024 * 1024) },
          },
        );
        outputs[index] = validateHelperResult(rootDir, batch, JSON.parse(stdout) as unknown);
      } catch (error) {
        const message = signal?.aborted ? "Python AST scan aborted" : `Python AST scan unavailable: ${error instanceof Error ? error.message : String(error)}`;
        outputs[index] = { engineVersion: "unknown", scannedFiles: [], findings: [], skipped: batch.map((filePath) => ({ filePath, reason: message })) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PYTHON_BATCH_CONCURRENCY, batches.length) }, worker));
  const engineVersions = new Set(outputs.map((output) => output.engineVersion).filter((version) => version !== "unknown"));
  const scannedFiles = outputs.flatMap((output) => output.scannedFiles);
  const findings = outputs.flatMap((output) => output.findings).slice(0, options.maxFindings ?? Number.POSITIVE_INFINITY);
  const skipped = outputs.flatMap((output) => output.skipped);
  const engineVersion = [...engineVersions].join(", ") || "unknown";
  return createScanResult({
    engine: "python-ast",
    engineVersion,
    rootDir,
    providerId: "python-ast",
    providerVersion: engineVersion,
    providerCapabilities: ["syntax", "resolution", "control-flow"],
    scannedFiles,
    findings,
    skipped,
  });
}
