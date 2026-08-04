import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashEntries(entries: Array<{ name: string; content: Buffer | string }>): string {
  const hash = createHash("sha256");
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    hash.update(entry.name);
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "artifacts") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs|py)$/.test(entry.name)) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function directoryFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "artifacts") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function hashDirectory(root: string, packageRoot: string): string {
  return hashEntries(directoryFiles(root).map((filePath) => ({
    name: path.relative(packageRoot, filePath).split(path.sep).join("/"),
    content: readFileSync(filePath),
  })));
}

export interface EvaluationRuntimeMetadata {
  node: string;
  nodeVersions: Record<string, string>;
  python: { executable: string; version: string | null };
  platform: string;
  arch: string;
}

export function evaluationRuntimeMetadata(): EvaluationRuntimeMetadata {
  const executable = process.env.PI_AI_SLOP_PYTHON ?? "python3";
  let version: string | null = null;
  try {
    version = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim() || null;
  } catch {
    // A missing Python runtime is recorded as unavailable, not hidden.
  }
  return {
    node: process.version,
    nodeVersions: Object.fromEntries(Object.entries(process.versions).map(([key, value]) => [key, value ?? ""])),
    python: { executable, version },
    platform: process.platform,
    arch: process.arch,
  };
}

export function hashProjectCode(packageRoot: string): string {
  const entries = sourceFiles(packageRoot).map((filePath) => ({
    name: path.relative(packageRoot, filePath).split(path.sep).join("/"),
    content: readFileSync(filePath),
  }));
  return hashEntries(entries);
}

export function hashCorpus(filePath: string): string {
  return hashEntries([{ name: path.basename(filePath), content: readFileSync(filePath) }]);
}

export function hashConfig(config: unknown): string {
  return hashEntries([{ name: "config.json", content: stableJson(config) }]);
}

export interface EvaluationInputHashes {
  code: string;
  corpus: string;
  rules: string;
  library: string;
  schema: string;
  package: string;
  config: string;
  runtime: string;
}

export function evaluationInputHashes(packageRoot: string, corpusPath: string, config: unknown): EvaluationInputHashes {
  const libraryRoot = path.join(packageRoot, "library");
  const schemaRoot = path.join(packageRoot, "schema");
  const packageEntries = ["package.json", "npm-shrinkwrap.json"].map((name) => ({
    name,
    content: readFileSync(path.join(packageRoot, name)),
  }));
  const runtime = evaluationRuntimeMetadata();
  return {
    code: hashProjectCode(packageRoot),
    corpus: hashCorpus(corpusPath),
    rules: hashEntries([{ name: "library/rules.yaml", content: readFileSync(path.join(libraryRoot, "rules.yaml")) }]),
    library: hashDirectory(libraryRoot, packageRoot),
    schema: hashDirectory(schemaRoot, packageRoot),
    package: hashEntries(packageEntries),
    config: hashConfig(config),
    runtime: hashConfig(runtime),
  };
}