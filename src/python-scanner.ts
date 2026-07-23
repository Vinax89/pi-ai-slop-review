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
  try {
    const { stdout } = await execFileAsync(
      process.env.PI_AI_SLOP_PYTHON ?? "python3",
      ["-I", "-S", HELPER_PATH, rootDir, ...paths],
      { encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout: 30_000, signal },
    );
    const parsed = JSON.parse(stdout) as PythonHelperResult;
    return createScanResult({
      engine: "python-ast",
      engineVersion: parsed.engineVersion,
      rootDir,
      providerId: "python-ast",
      providerVersion: parsed.engineVersion,
      providerCapabilities: ["syntax", "resolution", "control-flow"],
      scannedFiles: parsed.scannedFiles,
      findings: parsed.findings,
      skipped: parsed.skipped,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createScanResult({
      engine: "python-ast",
      engineVersion: "unknown",
      rootDir,
      providerId: "python-ast",
      providerVersion: "unknown",
      providerCapabilities: ["syntax", "resolution", "control-flow"],
      scannedFiles: [],
      findings: [],
      skipped: paths.map((filePath) => ({ filePath, reason: `Python AST scan unavailable: ${message}` })),
    });
  }
}
