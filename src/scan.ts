import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const GRAPH_ONLY_FILES = new Set(["package.json", "pyproject.toml"]);

import { scanPythonFiles } from "./python-scanner.ts";
import { federateEvidence, type FederationOptions } from "./providers/federation.ts";
import { createResourceBudget, resourceBudgetDiagnostic } from "./core/budget.ts";
import { assessScanCompleteness } from "./core/completeness.ts";
import { DEFAULT_CONFIG } from "./core/config.ts";
import { canonicalFilePath, createScanResult, scanIdFor, withFileHashCache } from "./core/schema.ts";
import { scanTypeScriptFilesWithProjects, type TypeScriptProjectContext } from "./typescript-scanner.ts";
import type { ScanResult, ScanScope, SkippedFile } from "./types.ts";

export interface ScanExecution {
  result: ScanResult;
  projects: TypeScriptProjectContext[];
}

export async function scanFiles(
  rootDir: string,
  inputPaths: string[],
  signal?: AbortSignal,
  mode: ScanScope["mode"] = "explicit",
  options: FederationOptions = {},
): Promise<ScanResult> {
  return (await scanFilesWithProjects(rootDir, inputPaths, signal, mode, options)).result;
}

export function scanFilesWithProjects(
  rootDir: string,
  inputPaths: string[],
  signal?: AbortSignal,
  mode: ScanScope["mode"] = "explicit",
  options: FederationOptions = {},
): Promise<ScanExecution> {
  return withFileHashCache(() => scanFilesUncached(rootDir, inputPaths, signal, mode, options));
}

async function scanFilesUncached(
  rootDir: string,
  inputPaths: string[],
  signal: AbortSignal | undefined,
  mode: ScanScope["mode"],
  options: FederationOptions,
): Promise<ScanExecution> {
  const root = realpathSync(rootDir);
  const config = options.config ?? DEFAULT_CONFIG;
  const budget = createResourceBudget(config.limits.commandTimeoutMs, options.memoryBudgetBytes);
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
    return {
      projects: [],
      result: createScanResult({
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
      }),
    };
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
    : scanTypeScriptFilesWithProjects(root, [...typescriptPaths, ...unsupportedPaths], { signal, maxFileBytes: config.limits.maxFileBytes, maxFindings: config.limits.maxFindings + 1, previousProjects: options.typescriptProjects });
  const nativeBudgetReason = resourceBudgetDiagnostic(budget);
  const python = nativeBudgetReason
    ? createScanResult({
        engine: "python-ast",
        engineVersion: "budget-exhausted",
        rootDir: root,
        providerId: "python-ast",
        providerVersion: "budget-exhausted",
        providers: [{ id: "python-ast", version: "budget-exhausted", capabilities: [], status: "skipped", diagnostic: nativeBudgetReason }],
        scannedFiles: [],
        findings: [],
        skipped: [{ filePath: "<python>", reason: nativeBudgetReason, providerId: "python-ast" }],
      })
    : await scanPythonFiles(root, pythonPaths, signal, {
        maxFileBytes: config.limits.maxFileBytes,
        maxOutputBytes: config.limits.maxOutputBytes,
        commandTimeoutMs: config.limits.commandTimeoutMs,
        maxFindings: config.limits.maxFindings + 1,
      });
  const result = await federateEvidence(root, scanPaths, [typescript.result, python], mode, {
    ...options,
    typescriptProjects: typescript.projects,
    graphSkipReason: typescriptPaths.length > 0 && typescript.projects.length === 0
      ? "repository graph skipped to keep TypeScript analysis within its memory budget"
      : undefined,
    budget,
    budgetReason: nativeBudgetReason,
  }, signal);
  result.skipped.push(...skipped);
  result.completeness = assessScanCompleteness(result);
  result.scanId = scanIdFor(result);
  return { result, projects: typescript.projects };
}
