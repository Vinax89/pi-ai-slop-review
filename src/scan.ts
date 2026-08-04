import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const GRAPH_ONLY_FILES = new Set(["package.json", "pyproject.toml"]);

import { scanPythonFiles } from "./python-scanner.ts";
import { federateEvidence, type FederationOptions } from "./providers/federation.ts";
import { assessScanCompleteness } from "./core/completeness.ts";
import { DEFAULT_CONFIG } from "./core/config.ts";
import { canonicalFilePath, createScanResult, scanIdFor } from "./core/schema.ts";
import { scanTypeScriptFilesWithProjects } from "./typescript-scanner.ts";
import type { ScanResult, ScanScope, SkippedFile } from "./types.ts";

export async function scanFiles(
  rootDir: string,
  inputPaths: string[],
  signal?: AbortSignal,
  mode: ScanScope["mode"] = "explicit",
  options: FederationOptions = {},
): Promise<ScanResult> {
  const root = realpathSync(rootDir);
  const config = options.config ?? DEFAULT_CONFIG;
  const uniquePaths = [...new Set(inputPaths.map((filePath) => canonicalFilePath(root, filePath)))];
  const skipped: SkippedFile[] = [];
  const eligible: string[] = [];
  for (const filePath of uniquePaths) {
    const absolute = path.resolve(root, filePath);
    if (existsSync(absolute) && !statSync(absolute).isFile()) {
      skipped.push({ filePath, reason: "path is not a file" });
    } else if (existsSync(absolute) && statSync(absolute).size > config.limits.maxFileBytes) {
      skipped.push({ filePath, reason: `file exceeds configured limit of ${config.limits.maxFileBytes} bytes` });
    } else {
      eligible.push(filePath);
    }
  }
  const scanPaths = eligible.slice(0, config.limits.maxFiles);
  skipped.push(
    ...eligible.slice(config.limits.maxFiles).map((filePath) => ({
      filePath,
      reason: `file omitted after configured file limit of ${config.limits.maxFiles}`,
    })),
  );
  if (signal?.aborted) {
    skipped.push(...scanPaths.map((filePath) => ({ filePath, reason: "scan aborted before native providers started" })));
    return createScanResult({
      engine: "provider-federation",
      engineVersion: "1",
      rootDir: root,
      mode,
      providerId: "scan",
      providerVersion: "1",
      providers: [{ id: "scan", version: "1", capabilities: [], status: "skipped", diagnostic: "scan aborted" }],
      scannedFiles: [],
      findings: [],
      skipped,
    });
  }
  const pythonPaths = scanPaths.filter((filePath) => path.extname(filePath).toLowerCase() === ".py");
  const pythonPathSet = new Set(pythonPaths);
  const graphOnlyPaths = scanPaths.filter((filePath) => {
    return path.extname(filePath).toLowerCase() === ".md" || GRAPH_ONLY_FILES.has(path.basename(filePath));
  });
  const graphOnlyPathSet = new Set(graphOnlyPaths);
  const otherPaths = scanPaths.filter((filePath) => !pythonPathSet.has(filePath) && !graphOnlyPathSet.has(filePath));
  const typescriptPaths = otherPaths.filter((filePath) => TYPESCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const typescriptPathSet = new Set(typescriptPaths);
  const unsupportedPaths = otherPaths.filter((filePath) => !typescriptPathSet.has(filePath));

  const typescript = signal?.aborted
    ? { result: createScanResult({ engine: "typescript-semantic", engineVersion: "aborted", rootDir: root, providerId: "typescript-semantic", providerVersion: "aborted", scannedFiles: [], findings: [], skipped: [] }), projects: [] }
    : scanTypeScriptFilesWithProjects(root, [...typescriptPaths, ...unsupportedPaths], { signal, maxFileBytes: config.limits.maxFileBytes, maxFindings: config.limits.maxFindings + 1 });
  const python = await scanPythonFiles(root, pythonPaths, signal, {
    maxFileBytes: config.limits.maxFileBytes,
    maxOutputBytes: config.limits.maxOutputBytes,
    maxFindings: config.limits.maxFindings + 1,
  });
  const result = await federateEvidence(root, scanPaths, [typescript.result, python], mode, {
    ...options,
    typescriptProjects: typescript.projects,
  }, signal);
  result.skipped.push(...skipped);
  result.completeness = assessScanCompleteness(result);
  result.scanId = scanIdFor(result);
  return result;
}
