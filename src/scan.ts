import path from "node:path";

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const GRAPH_ONLY_FILES = new Set(["package.json", "pyproject.toml"]);

import { scanPythonFiles } from "./python-scanner.ts";
import { federateEvidence, type FederationOptions } from "./providers/federation.ts";
import { scanTypeScriptFiles } from "./typescript-scanner.ts";
import type { ScanResult, ScanScope } from "./types.ts";

export async function scanFiles(
  rootDir: string,
  inputPaths: string[],
  signal?: AbortSignal,
  mode: ScanScope["mode"] = "explicit",
  options: FederationOptions = {},
): Promise<ScanResult> {
  const uniquePaths = [...new Set(inputPaths)];
  const pythonPaths = uniquePaths.filter((filePath) => path.extname(filePath.replace(/^@/, "")).toLowerCase() === ".py");
  const graphOnlyPaths = uniquePaths.filter((filePath) => {
    const normalized = filePath.replace(/^@/, "");
    return path.extname(normalized).toLowerCase() === ".md" || GRAPH_ONLY_FILES.has(path.basename(normalized));
  });
  const otherPaths = uniquePaths.filter((filePath) => !pythonPaths.includes(filePath) && !graphOnlyPaths.includes(filePath));
  const typescriptPaths = otherPaths.filter((filePath) => TYPESCRIPT_EXTENSIONS.has(path.extname(filePath.replace(/^@/, "")).toLowerCase()));
  const unsupportedPaths = otherPaths.filter((filePath) => !typescriptPaths.includes(filePath));

  const typescript = scanTypeScriptFiles(rootDir, [...typescriptPaths, ...unsupportedPaths]);
  const python = await scanPythonFiles(rootDir, pythonPaths, signal);
  return federateEvidence(rootDir, uniquePaths, [typescript, python], mode, options, signal);
}
