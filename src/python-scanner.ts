import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createScanResult } from "./core/schema.ts";
import type { FindingDraft, ScanResult, SkippedFile } from "./types.ts";

interface PythonHelperResult {
  engineVersion: string;
  scannedFiles: string[];
  findings: FindingDraft[];
  skipped: SkippedFile[];
}

const execFileAsync = promisify(execFile);
const HELPER_PATH = fileURLToPath(new URL("./python_helper.py", import.meta.url));
const PYTHON_BATCH_SIZE = 500;
const PYTHON_BATCH_CONCURRENCY = 4;

export async function scanPythonFiles(rootDir: string, paths: string[], signal?: AbortSignal): Promise<ScanResult> {
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
          { encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout: 30_000, signal },
        );
        outputs[index] = JSON.parse(stdout) as PythonHelperResult;
      } catch (error) {
        const message = signal?.aborted ? "Python AST scan aborted" : `Python AST scan unavailable: ${error instanceof Error ? error.message : String(error)}`;
        outputs[index] = { engineVersion: "unknown", scannedFiles: [], findings: [], skipped: batch.map((filePath) => ({ filePath, reason: message })) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PYTHON_BATCH_CONCURRENCY, batches.length) }, worker));
  const engineVersions = new Set(outputs.map((output) => output.engineVersion).filter((version) => version !== "unknown"));
  const scannedFiles = outputs.flatMap((output) => output.scannedFiles);
  const findings = outputs.flatMap((output) => output.findings);
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
