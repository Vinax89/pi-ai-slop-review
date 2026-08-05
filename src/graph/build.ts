import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import * as ts from "typescript";

import type { AiSlopConfig } from "../core/config.ts";
import { contentHashOnce, fingerprint, normalizePath, sha256 } from "../core/schema.ts";
import { canonicalSymbol } from "../core/typescript.ts";
import { safeProjectFile } from "../providers/files.ts";
import { batchTypeScriptFiles, type TypeScriptProjectContext } from "../typescript-scanner.ts";
import type { GraphEdge, GraphFileFacts, GraphNode, GraphNodeKind } from "./types.ts";

const execFileAsync = promisify(execFile);
const PYTHON_HELPER = fileURLToPath(new URL("../python_graph_helper.py", import.meta.url));
const PYTHON_BATCH_SIZE = 500;
const PYTHON_BATCH_CONCURRENCY = 2;
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
type GraphCacheRecord = { cacheHash: string; contentHash?: string };
function pythonGraphCacheHash(contentHash: string): string {
  return sha256(`${contentHash}\0${process.env.PI_AI_SLOP_PYTHON ?? "python3"}\0${contentHashOnce(PYTHON_HELPER)}`);
}


function matches(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return path.matchesGlob(filePath, pattern);
    } catch {
      return filePath.includes(pattern.replace(/\*+/g, ""));
    }
  });
}

function nodeId(filePath: string, kind: GraphNodeKind, qualifiedName: string): string {
  return fingerprint("graph-node", { filePath, kind, qualifiedName });
}

function edge(
  filePath: string,
  fromId: string,
  toId: string,
  kind: GraphEdge["kind"],
  confidence: GraphEdge["confidence"],
  metadata: Record<string, unknown> = {},
): GraphEdge {
  return {
    id: fingerprint("graph-edge", { filePath, fromId, toId, kind, metadata }),
    filePath,
    fromId,
    toId,
    kind,
    confidence,
    metadata,
  };
}

function fileNode(filePath: string, sourceLength: number, language: string): GraphNode {
  return {
    id: nodeId(filePath, "file", filePath),
    filePath,
    kind: "file",
    name: path.basename(filePath),
    qualifiedName: filePath,
    start: 0,
    end: sourceLength,
    exported: false,
    metadata: { language },
  };
}

function declarationName(node: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) return node.name.text;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isMethodDeclaration(node) && node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) return node.name.text;
  return undefined;
}

function graphKind(node: ts.Node, isTest: boolean): GraphNodeKind | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return isTest ? "test" : "function";
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return isTest ? "test" : "function";
  }
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isVariableDeclaration(node)) return "variable";
  return undefined;
}

function qualifiedName(node: ts.Node, name: string): string {
  const names = [name];
  let current = node.parent;
  while (current) {
    const parentName = declarationName(current);
    if (parentName) names.push(parentName);
    current = current.parent;
  }
  return names.reverse().join(".");
}

function declarationBody(node: ts.Node): ts.Node | undefined {
  if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
    return node.initializer.body;
  }
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.body;
  if (ts.isClassDeclaration(node)) return node;
  return undefined;
}

function bodyHash(node: ts.Node): string | undefined {
  const body = declarationBody(node);
  if (!body) return undefined;
  if (ts.isBlock(body) && body.statements.length < 2) return undefined;
  if (ts.isClassDeclaration(body) && body.members.length < 2) return undefined;
  if (!ts.isBlock(body) && !ts.isClassDeclaration(body)) return undefined;
  return sha256(body.getText().replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "").replace(/\s+/g, " ").trim());
}

function isExported(checker: ts.TypeChecker, sourceFile: ts.SourceFile, node: ts.Node, nameNode: ts.Node): boolean {
  if (ts.canHaveModifiers(node)) {
    const modifiers = ts.getModifiers(node) ?? [];
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword)) return true;
  }
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(nameNode));
  return Boolean(moduleSymbol && symbol && checker.getExportsOfModule(moduleSymbol).some((item) => canonicalSymbol(checker, item) === symbol));
}

function frameworkMetadata(name: string, exported: boolean, sourceFile: ts.SourceFile): Record<string, unknown> {
  const nextHandler = exported && ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "default"].includes(name);
  const reactBoundary = exported && /^[A-Z]/.test(name) && /\.[jt]sx$/.test(sourceFile.fileName);
  return {
    frameworkBoundary: nextHandler ? "next-route" : reactBoundary ? "react-component" : undefined,
  };
}

function configPathForFile(rootDir: string, filePath: string): string | undefined {
  const configPath = ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, "tsconfig.json") ?? ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, "jsconfig.json");
  return configPath && normalizePath(configPath).startsWith(`${normalizePath(rootDir)}/`) ? configPath : undefined;
}

function configForFiles(files: string[], configPath?: string, bounded = false): { rootNames: string[]; options: ts.CompilerOptions } {
  const boundedOptions: ts.CompilerOptions = bounded ? { noResolve: true, types: [] } : {};
  if (!configPath) {
    return {
      rootNames: files,
      options: {
        allowJs: true,
        checkJs: false,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        ...boundedOptions,
      },
    };
  }
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) return { rootNames: files, options: boundedOptions };
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(configPath));
  return { rootNames: files, options: { ...parsed.options, allowJs: true, ...boundedOptions } };
}

function declarationId(rootDir: string, checker: ts.TypeChecker, symbol: ts.Symbol | undefined): string | undefined {
  const canonical = canonicalSymbol(checker, symbol);
  const declaration = canonical?.valueDeclaration ?? canonical?.declarations?.[0];
  if (!canonical || !declaration) return undefined;
  const sourceFile = declaration.getSourceFile();
  const absolute = path.resolve(sourceFile.fileName);
  if (!normalizePath(absolute).startsWith(`${normalizePath(rootDir)}/`)) return fingerprint("graph-external", { name: canonical.name });
  const filePath = normalizePath(path.relative(rootDir, absolute));
  const kind = graphKind(declaration, false) ?? "external";
  return nodeId(filePath, kind, qualifiedName(declaration, canonical.name));
}

function extractTypescript(
  rootDir: string,
  inputFiles: string[],
  config: AiSlopConfig,
  reusableProjects: TypeScriptProjectContext[] = [],
  cached: Map<string, GraphCacheRecord> = new Map(),
  onFacts?: (facts: GraphFileFacts[]) => void,
): { facts: GraphFileFacts[]; cachedFiles: string[] } {
  const groups = new Map<string, string[]>();
  const configPaths = new Map<string, string | undefined>();
  const reusableByKey = new Map<string, TypeScriptProjectContext>();
  const reusableByFile = new Map<string, string>();
  for (const [index, project] of reusableProjects.entries()) {
    const key = `<reusable:${index}>`;
    reusableByKey.set(key, project);
    for (const filePath of project.files) reusableByFile.set(normalizePath(filePath), key);
  }
  for (const filePath of inputFiles) {
    const directory = path.dirname(filePath);
    let key = reusableByFile.get(normalizePath(filePath));
    if (!key) {
      if (!configPaths.has(directory)) configPaths.set(directory, configPathForFile(rootDir, filePath));
      key = configPaths.get(directory) ?? "<none>";
    }
    const group = groups.get(key);
    if (group) group.push(filePath);
    else groups.set(key, [filePath]);
  }
  const facts: GraphFileFacts[] = [];
  const cachedFiles: string[] = [];
  for (const [key, groupFiles] of groups) {
    for (const files of batchTypeScriptFiles(groupFiles)) {
      const batchFacts: GraphFileFacts[] = [];
      const reusable = reusableByKey.get(key);
      const configured = reusable ? undefined : configForFiles(files, key === "<none>" ? undefined : key, groupFiles.length > files.length);
      const options = reusable?.options ?? configured!.options;
      let compilerContext = JSON.stringify(options);
      const contextPath = reusable?.configPath ?? (key === "<none>" || key.startsWith("<reusable:") ? undefined : key);
      if (contextPath) {
        try {
          compilerContext += `\0${readFileSync(contextPath, "utf8")}`;
        } catch {
          compilerContext += `\0${contextPath}`;
        }
      }
      const compilerContextHash = sha256(compilerContext);
      const sourceHashes = new Map(files.map((absolutePath) => [absolutePath, contentHashOnce(absolutePath)]));
      const changedFiles = files.filter((absolutePath) => {
        const filePath = normalizePath(path.relative(rootDir, absolutePath));
        const contentHash = sourceHashes.get(absolutePath)!;
        const cacheHash = sha256(`${contentHash}\0${compilerContextHash}`);
        const current = cached.get(filePath);
        if (current?.contentHash === contentHash && current.cacheHash === cacheHash) {
          cachedFiles.push(filePath);
          return false;
        }
        return true;
      });
      if (!changedFiles.length) continue;
      const program = reusable?.program ?? ts.createProgram({ rootNames: changedFiles, options });
      const checker = reusable?.checker ?? program.getTypeChecker();
      for (const absolutePath of changedFiles) {
      const sourceFile = program.getSourceFile(absolutePath);
      if (!sourceFile) continue;
      const source = sourceFile.text;
      const filePath = normalizePath(path.relative(rootDir, absolutePath));
      const isTest = matches(filePath, config.graph.testPatterns);
      const rootNode = fileNode(filePath, source.length, "typescript");
      const nodes: GraphNode[] = [rootNode];
      const edges: GraphEdge[] = [];
      const declarationNodes = new Map<ts.Node, GraphNode>();
      const visitDeclarations = (node: ts.Node): void => {
        const name = declarationName(node);
        const kind = graphKind(node, isTest || Boolean(name?.startsWith("test")));
        if (name && kind) {
          const nameNode = (node as any).name as ts.Node;
          const exported = isExported(checker, sourceFile, node, nameNode);
          const qualified = qualifiedName(node, name);
          const start = node.getStart(sourceFile);
          const graphNode: GraphNode = {
            id: nodeId(filePath, kind, qualified),
            filePath,
            kind,
            name,
            qualifiedName: qualified,
            start,
            end: node.getEnd(),
            exported,
            signature: checker.typeToString(checker.getTypeAtLocation(nameNode)),
            bodyHash: bodyHash(node),
            metadata: frameworkMetadata(name, exported, sourceFile),
          };
          nodes.push(graphNode);
          declarationNodes.set(node, graphNode);
          edges.push(edge(filePath, rootNode.id, graphNode.id, "contains", "C3"));
          if (exported) edges.push(edge(filePath, rootNode.id, graphNode.id, "exports", "C3"));
          if (graphNode.metadata.frameworkBoundary) {
            const registration: GraphNode = {
              id: nodeId(filePath, "registration", `${qualified}@${String(graphNode.metadata.frameworkBoundary)}`),
              filePath,
              kind: "registration",
              name: String(graphNode.metadata.frameworkBoundary),
              qualifiedName: `${qualified}@${String(graphNode.metadata.frameworkBoundary)}`,
              start,
              end: node.getEnd(),
              exported: false,
              metadata: { target: graphNode.id, framework: graphNode.metadata.frameworkBoundary },
            };
            nodes.push(registration);
            edges.push(edge(filePath, registration.id, graphNode.id, "registers", "C3"));
          }
        }
        ts.forEachChild(node, visitDeclarations);
      };
      visitDeclarations(sourceFile);

      const ownerId = (node: ts.Node): string => {
        let current: ts.Node | undefined = node.parent;
        while (current) {
          const owner = declarationNodes.get(current) ?? (current.parent && ts.isVariableDeclaration(current.parent) ? declarationNodes.get(current.parent) : undefined);
          if (owner) return owner.id;
          current = current.parent;
        }
        return rootNode.id;
      };
      const visitEdges = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const specifier = node.moduleSpecifier.text;
          const resolved = ts.resolveModuleName(specifier, absolutePath, options, ts.sys).resolvedModule?.resolvedFileName;
          const targetId = resolved && normalizePath(path.resolve(resolved)).startsWith(`${normalizePath(rootDir)}/`)
            ? nodeId(normalizePath(path.relative(rootDir, resolved)), "file", normalizePath(path.relative(rootDir, resolved)))
            : fingerprint("graph-dependency", { specifier });
          edges.push(edge(filePath, rootNode.id, targetId, "imports", resolved ? "C3" : "C2", { specifier, resolved: resolved ? normalizePath(path.relative(rootDir, resolved)) : undefined }));
        }
        if (ts.isCallExpression(node)) {
          const symbol = checker.getSymbolAtLocation(node.expression);
          const targetId = declarationId(rootDir, checker, symbol) ?? fingerprint("graph-call", { target: node.expression.getText(sourceFile) });
          const sourceId = ownerId(node);
          edges.push(edge(filePath, sourceId, targetId, "calls", symbol ? "C3" : "C1", { target: node.expression.getText(sourceFile) }));
          if (isTest) edges.push(edge(filePath, sourceId, targetId, "covers", symbol ? "C2" : "C1"));
          const targetText = node.expression.getText(sourceFile);
          if (/\.(?:get|post|put|patch|delete|route|register|command|task)$/.test(targetText)) {
            const registration: GraphNode = {
              id: nodeId(filePath, "registration", `${sourceId}@${targetText}:${node.getStart(sourceFile)}`),
              filePath,
              kind: "registration",
              name: targetText,
              qualifiedName: `${sourceId}@${targetText}`,
              start: node.getStart(sourceFile),
              end: node.getEnd(),
              exported: false,
              metadata: { target: targetText, framework: "call-registration" },
            };
            nodes.push(registration);
            edges.push(edge(filePath, sourceId, registration.id, "registers", "C2"));
          }
        }
        ts.forEachChild(node, visitEdges);
      };
      visitEdges(sourceFile);
      const uniqueNodes = new Map<string, GraphNode>();
      for (const graphNode of nodes) {
        const current = uniqueNodes.get(graphNode.id);
        if (!current || (!current.bodyHash && graphNode.bodyHash)) uniqueNodes.set(graphNode.id, graphNode);
      }
      const uniqueEdges = [...new Map(edges.map((graphEdge) => [graphEdge.id, graphEdge])).values()];
      const sourceHash = sourceHashes.get(absolutePath)!;
      batchFacts.push({ filePath, sourceHash, cacheHash: sha256(`${sourceHash}\0${compilerContextHash}`), source, language: "typescript", nodes: [...uniqueNodes.values()], edges: uniqueEdges });
    }
      if (batchFacts.length) {
        if (onFacts) onFacts(batchFacts);
        else facts.push(...batchFacts);
      }
      if (!reusable) global.gc?.();
    }
  }
  return { facts, cachedFiles };
}

interface PythonGraphOutput {
  files: Record<string, { nodes: Array<Omit<GraphNode, "id" | "filePath">>; edges: Array<{ from: string; to: string; kind: GraphEdge["kind"]; confidence: GraphEdge["confidence"]; metadata: Record<string, unknown> }> }>;
  errors: Record<string, string>;
}
function validatePythonGraphOutput(rootDir: string, requestedPaths: string[], value: unknown): PythonGraphOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Python graph helper returned a non-object JSON value");
  const document = value as Record<string, unknown>;
  if (!document.files || typeof document.files !== "object" || Array.isArray(document.files)) throw new Error("Python graph helper JSON must contain an object files field");
  if (!document.errors || typeof document.errors !== "object" || Array.isArray(document.errors)) throw new Error("Python graph helper JSON must contain an object errors field");
  const requested = new Set(requestedPaths.map((filePath) => normalizePath(filePath.replace(/^@/, ""))));
  const files: PythonGraphOutput["files"] = {};
  const errors: Record<string, string> = {};
  const validatePath = (rawPath: string): string => {
    const filePath = normalizePath(rawPath);
    const absolute = path.resolve(rootDir, filePath);
    if (path.isAbsolute(rawPath) || !requested.has(filePath) || !normalizePath(absolute).startsWith(`${normalizePath(rootDir)}/`)) {
      throw new Error(`Python graph helper returned an invalid path: ${rawPath}`);
    }
    return filePath;
  };
  for (const [rawPath, raw] of Object.entries(document.files)) {
    const filePath = validatePath(rawPath);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Python graph helper file entry is not an object: ${filePath}`);
    const item = raw as Record<string, unknown>;
    if (!Array.isArray(item.nodes) || !Array.isArray(item.edges)) throw new Error(`Python graph helper file entry has invalid nodes or edges: ${filePath}`);
    for (const node of item.nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error(`Python graph helper returned an invalid node: ${filePath}`);
      const candidate = node as Record<string, unknown>;
      if (typeof candidate.kind !== "string" || !["file", "function", "class", "variable", "import", "test", "specification", "requirement", "registration", "dependency", "external"].includes(candidate.kind) ||
        typeof candidate.name !== "string" || typeof candidate.qualifiedName !== "string" ||
        typeof candidate.start !== "number" || !Number.isSafeInteger(candidate.start) || candidate.start < 0 ||
        typeof candidate.end !== "number" || !Number.isSafeInteger(candidate.end) || candidate.end < candidate.start ||
        typeof candidate.exported !== "boolean" || !candidate.metadata || typeof candidate.metadata !== "object" || Array.isArray(candidate.metadata)) {
        throw new Error(`Python graph helper returned a malformed node: ${filePath}`);
      }
    }
    for (const edge of item.edges) {
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) throw new Error(`Python graph helper returned an invalid edge: ${filePath}`);
      const candidate = edge as Record<string, unknown>;
      if (typeof candidate.from !== "string" || typeof candidate.to !== "string" ||
        !["contains", "imports", "calls", "exports", "covers", "governs", "registers", "depends-on", "duplicates"].includes(String(candidate.kind)) ||
        !["C1", "C2", "C3"].includes(String(candidate.confidence)) ||
        !candidate.metadata || typeof candidate.metadata !== "object" || Array.isArray(candidate.metadata)) {
        throw new Error(`Python graph helper returned a malformed edge: ${filePath}`);
      }
    }
    files[filePath] = raw as PythonGraphOutput["files"][string];
  }
  for (const [rawPath, reason] of Object.entries(document.errors)) {
    const filePath = validatePath(rawPath);
    if (typeof reason !== "string") throw new Error(`Python graph helper returned a non-string error: ${filePath}`);
    errors[filePath] = reason;
  }
  for (const filePath of requested) {
    if (!files[filePath] && !errors[filePath]) errors[filePath] = "Python graph helper omitted this requested path";
  }
  return { files, errors };
}


async function runPythonGraphHelper(
  rootDir: string,
  paths: string[],
  signal?: AbortSignal,
  maxFileBytes = 1024 * 1024,
  maxOutputBytes = 8 * 1024 * 1024,
  commandTimeoutMs = 120_000,
): Promise<PythonGraphOutput> {
  const { stdout } = await execFileAsync(process.env.PI_AI_SLOP_PYTHON ?? "python3", ["-I", "-S", PYTHON_HELPER, rootDir, ...paths], {
    encoding: "utf8",
    maxBuffer: maxOutputBytes,
    timeout: commandTimeoutMs,
    signal,
    env: { ...process.env, PI_AI_SLOP_MAX_FILE_BYTES: String(maxFileBytes) },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Python graph helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validatePythonGraphOutput(rootDir, paths, parsed);
}

function resolvePythonImport(filePath: string, module: string, level: number, knownFiles: Set<string>): string | undefined {
  const modulePath = module.split(".").filter(Boolean).join("/");
  if (!modulePath) return undefined;
  const relativeBase = path.dirname(filePath);
  const packageBase = level > 0
    ? Array.from({ length: Math.max(0, level - 1) }, (_, index) => index).reduce((current) => path.dirname(current), relativeBase)
    : "";
  const roots = level > 0 ? [packageBase] : ["", "src"];
  for (const root of roots) {
    for (const candidate of [`${path.join(root, modulePath)}.py`, path.join(root, modulePath, "__init__.py")]) {
      const normalized = normalizePath(candidate);
      if (knownFiles.has(normalized)) return normalized;
    }
  }
  return undefined;
}

async function extractPython(
  rootDir: string,
  paths: string[],
  signal?: AbortSignal,
  maxFileBytes = 1024 * 1024,
  maxOutputBytes = 8 * 1024 * 1024,
  commandTimeoutMs = 120_000,
  onFacts?: (facts: GraphFileFacts[]) => void,
): Promise<{ facts: GraphFileFacts[]; errors: Record<string, string> }> {
  if (!paths.length) return { facts: [], errors: {} };
  const batches = Array.from({ length: Math.ceil(paths.length / PYTHON_BATCH_SIZE) }, (_, index) =>
    paths.slice(index * PYTHON_BATCH_SIZE, (index + 1) * PYTHON_BATCH_SIZE));
  const knownFiles = new Set(paths);
  const facts: GraphFileFacts[] = [];
  const errors: Record<string, string> = {};
  let nextBatch = 0;
  const worker = async (): Promise<void> => {
    while (nextBatch < batches.length) {
      const index = nextBatch;
      nextBatch += 1;
      const batch = batches[index]!;
      let output: PythonGraphOutput;
      if (signal?.aborted) {
        output = { files: {}, errors: Object.fromEntries(batch.map((filePath) => [filePath, "Python graph scan aborted"])) };
      } else {
        try {
          output = await runPythonGraphHelper(rootDir, batch, signal, maxFileBytes, maxOutputBytes, commandTimeoutMs);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (batch.length > 1 && ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || detail.includes("maxBuffer"))) {
            const middle = Math.ceil(batch.length / 2);
            batches.push(batch.slice(0, middle), batch.slice(middle));
            continue;
          }
          const message = signal?.aborted
            ? "Python graph scan aborted"
            : detail.startsWith("Python graph helper ")
              ? `Python graph scan invalid: ${detail}`
              : `Python graph scan unavailable: ${detail}`;
          output = { files: {}, errors: Object.fromEntries(batch.map((filePath) => [filePath, message])) };
        }
      }
      Object.assign(errors, output.errors);
      const batchFacts: GraphFileFacts[] = [];
      for (const [filePath, raw] of Object.entries(output.files)) {
        let source: string;
        try {
          source = readFileSync(path.join(rootDir, filePath), "utf8");
        } catch (error) {
          errors[filePath] = `cannot read Python graph source: ${error instanceof Error ? error.message : String(error)}`;
          continue;
        }
        const rootNode = fileNode(filePath, source.length, "python");
        const nodes: GraphNode[] = [rootNode];
        for (const rawNode of raw.nodes) {
          nodes.push({ ...rawNode, id: nodeId(filePath, rawNode.kind, rawNode.qualifiedName), filePath });
        }
        const byQualified = new Map(nodes.map((node) => [node.qualifiedName, node.id]));
        const byName = new Map(nodes.map((node) => [node.name, node.id]));
        const edges = raw.edges.map((rawEdge) => {
          const fromId = rawEdge.from === "<file>" ? rootNode.id : byQualified.get(rawEdge.from) ?? byName.get(rawEdge.from) ?? fingerprint("graph-python", { filePath, name: rawEdge.from });
          const rawTarget = rawEdge.to.replace(/^(?:call|module|registration):/, "");
          const metadata = { ...rawEdge.metadata };
          let toId = byQualified.get(rawTarget) ?? byName.get(rawTarget.split(".").at(-1) ?? rawTarget) ?? fingerprint("graph-python-target", { rawTarget });
          if (rawEdge.kind === "imports") {
            const level = typeof metadata.level === "number" ? metadata.level : 0;
            const resolved = resolvePythonImport(filePath, rawTarget, level, knownFiles);
            if (resolved) {
              toId = nodeId(resolved, "file", resolved);
              metadata.resolved = resolved;
            }
          }
          return edge(filePath, fromId, toId, rawEdge.kind, rawEdge.confidence, metadata);
        });
        for (const node of nodes.slice(1)) {
          edges.push(edge(filePath, rootNode.id, node.id, "contains", "C3"));
          if (node.exported) edges.push(edge(filePath, rootNode.id, node.id, "exports", "C2"));
          if (node.kind === "test") {
            for (const call of edges.filter((item) => item.kind === "calls" && item.fromId === node.id)) {
              edges.push(edge(filePath, node.id, call.toId, "covers", "C1"));
            }
          }
        }
        const sourceHash = contentHashOnce(path.resolve(rootDir, filePath), source);
        batchFacts.push({ filePath, sourceHash, cacheHash: pythonGraphCacheHash(sourceHash), language: path.basename(filePath) === "pyproject.toml" ? "toml" : "python", nodes, edges });
      }
      if (onFacts) onFacts(batchFacts);
      else facts.push(...batchFacts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PYTHON_BATCH_CONCURRENCY, batches.length) }, worker));
  return { facts, errors };
}

function extractPackageJson(rootDir: string, paths: string[]): { facts: GraphFileFacts[]; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const facts = paths.flatMap((rawPath) => {
    const file = safeProjectFile(rootDir, rawPath);
    if (!file || path.basename(file.filePath) !== "package.json") return [];
    let document: Record<string, any>;
    try {
      document = JSON.parse(file.source) as Record<string, any>;
    } catch (error) {
      errors[file.filePath] = `cannot parse package manifest: ${error instanceof Error ? error.message : String(error)}`;
      return [];
    }
    const rootNode = fileNode(file.filePath, file.source.length, "json");
    const nodes: GraphNode[] = [rootNode];
    const edges: GraphEdge[] = [];
    const registrations: Array<{ name: string; target: string; framework: string }> = [];
    for (const key of ["main", "module", "types"]) {
      if (typeof document[key] === "string") registrations.push({ name: key, target: document[key], framework: "package-entry" });
    }
    if (typeof document.bin === "string") registrations.push({ name: "bin", target: document.bin, framework: "package-bin" });
    else if (document.bin && typeof document.bin === "object") {
      for (const [name, target] of Object.entries(document.bin)) if (typeof target === "string") registrations.push({ name, target, framework: "package-bin" });
    }
    const collectExports = (value: unknown, prefix: string): void => {
      if (typeof value === "string") registrations.push({ name: prefix || ".", target: value, framework: "package-export" });
      else if (value && typeof value === "object") for (const [key, nested] of Object.entries(value)) collectExports(nested, prefix ? `${prefix}:${key}` : key);
    };
    collectExports(document.exports, "");
    for (const registration of registrations) {
      const node: GraphNode = {
        id: nodeId(file.filePath, "registration", `${registration.framework}:${registration.name}`),
        filePath: file.filePath,
        kind: "registration",
        name: registration.name,
        qualifiedName: `${registration.framework}:${registration.name}`,
        start: 0,
        end: file.source.length,
        exported: true,
        metadata: { framework: registration.framework, target: registration.target },
      };
      nodes.push(node);
      edges.push(edge(file.filePath, rootNode.id, node.id, "registers", "C3", node.metadata));
    }
    for (const group of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      if (!document[group] || typeof document[group] !== "object") continue;
      for (const [name, version] of Object.entries(document[group])) {
        const dependencyId = fingerprint("graph-dependency", { name });
        edges.push(edge(file.filePath, rootNode.id, dependencyId, "depends-on", "C3", { group, name, version }));
      }
    }
    return [{ filePath: file.filePath, sourceHash: contentHashOnce(path.resolve(rootDir, file.filePath), file.source), language: "json", nodes, edges }];
  });
  return { facts, errors };
}

function extractMarkdown(rootDir: string, paths: string[], config: AiSlopConfig): GraphFileFacts[] {
  return paths.flatMap((rawPath) => {
    const file = safeProjectFile(rootDir, rawPath);
    if (!file) return [];
    const rootNode = fileNode(file.filePath, file.source.length, "markdown");
    const nodes: GraphNode[] = [rootNode];
    const edges: GraphEdge[] = [];
    if (!matches(file.filePath, config.graph.specPatterns)) {
      return [{ filePath: file.filePath, sourceHash: contentHashOnce(path.resolve(rootDir, file.filePath), file.source), language: "markdown", nodes, edges }];
    }
    rootNode.kind = "specification";
    const headings: Array<{ start: number; end: number; name: string; level: number }> = [];
    const visibleLines: string[] = [];
    let offset = 0;
    let fence: { character: string; length: number } | undefined;
    for (const line of file.source.split(/(?<=\n)/)) {
      const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        visibleLines.push(line.replace(/[^\r\n]/g, " "));
        if (fenceMatch && fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length) fence = undefined;
        offset += line.length;
        continue;
      }
      if (fenceMatch) {
        visibleLines.push(line.replace(/[^\r\n]/g, " "));
        fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
        offset += line.length;
        continue;
      }
      visibleLines.push(line);
      const headingMatch = line.match(/^(#{1,6})\s+(.+?)(?:\r?\n)?$/);
      if (headingMatch) {
        const end = offset + headingMatch[0].replace(/\r?\n$/, "").length;
        headings.push({ start: offset, end, name: headingMatch[2].trim(), level: headingMatch[1].length });
      }
      offset += line.length;
    }
    for (const [index, heading] of headings.entries()) {
      const requirement = /\b(?:REQ|OBL|ADR|R)[-_ ]?\d+\b/i.test(heading.name);
      const kind: GraphNodeKind = requirement ? "requirement" : "specification";
      const node: GraphNode = {
        id: nodeId(file.filePath, kind, heading.name),
        filePath: file.filePath,
        kind,
        name: heading.name,
        qualifiedName: heading.name,
        start: heading.start,
        end: heading.end,
        exported: false,
        metadata: { headingLevel: heading.level },
      };
      nodes.push(node);
      edges.push(edge(file.filePath, rootNode.id, node.id, "contains", "C3"));
      const sectionEnd = headings[index + 1]?.start ?? file.source.length;
      const section = visibleLines.join("").slice(heading.end, sectionEnd);
      for (const pathMatch of section.matchAll(/`([^`]+\.[A-Za-z0-9]+)`|\[[^\]]+\]\(([^)]+)\)/g)) {
        const targetPath = pathMatch[1] ?? pathMatch[2];
        if (!targetPath || /^(?:https?|mailto|tel):/i.test(targetPath)) continue;
        const withoutFragment = targetPath.split(/[?#]/, 1)[0];
        if (!withoutFragment) continue;
        let decodedPath = withoutFragment;
        try {
          decodedPath = decodeURIComponent(withoutFragment);
        } catch {
          continue;
        }
        const target = safeProjectFile(rootDir, path.resolve(rootDir, path.dirname(file.filePath), decodedPath));
        if (target) edges.push(edge(file.filePath, node.id, nodeId(target.filePath, "file", target.filePath), "governs", "C2", { targetPath: target.filePath }));
      }
    }
    return [{ filePath: file.filePath, sourceHash: contentHashOnce(path.resolve(rootDir, file.filePath), file.source), language: "markdown", nodes, edges }];
  });
}

export async function buildGraphFacts(
  rootDir: string,
  paths: string[],
  config: AiSlopConfig,
  signal?: AbortSignal,
  reusableProjects: TypeScriptProjectContext[] = [],
  cached: Map<string, GraphCacheRecord> = new Map(),
  onFacts?: (facts: GraphFileFacts[]) => void,
): Promise<{ facts: GraphFileFacts[]; errors: Record<string, string>; cachedFiles: string[] }> {
  const root = realpathSync(rootDir);
  const errors: Record<string, string> = {};
  if (signal?.aborted) {
    return { facts: [], errors: Object.fromEntries(paths.map((filePath) => [normalizePath(filePath.replace(/^@/, "")), "graph scan aborted"])), cachedFiles: [] };
  }
  const valid: string[] = [];
  for (const rawPath of paths) {
    const display = normalizePath(rawPath.replace(/^@/, ""));
    const absolute = path.resolve(root, display);
    if (!existsSync(absolute)) continue;
    let real: string;
    try {
      real = realpathSync(absolute);
    } catch {
      errors[display] = "cannot resolve graph source path";
      continue;
    }
    let stats;
    try {
      stats = statSync(real);
    } catch {
      errors[display] = "cannot stat graph source path";
      continue;
    }
    if (!normalizePath(real).startsWith(`${normalizePath(root)}/`)) {
      errors[display] = "path resolves outside the project root";
      continue;
    }
    if (!stats.isFile()) {
      errors[display] = "path is not a file";
      continue;
    }
    if (stats.size > config.limits.maxFileBytes) {
      errors[display] = `file exceeds configured limit of ${config.limits.maxFileBytes} bytes`;
      continue;
    }
    valid.push(real);
  }
  if (signal?.aborted) {
    return { facts: [], errors: Object.fromEntries(paths.map((filePath) => [normalizePath(filePath.replace(/^@/, "")), "graph scan aborted"])), cachedFiles: [] };
  }
  const typescriptFiles = valid.filter((filePath) => TYPESCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const cachedFiles: string[] = [];
  const changedNonTypescript = valid.filter((filePath) => !TYPESCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase())).filter((filePath) => {
    const display = normalizePath(path.relative(root, filePath));
    const contentHash = contentHashOnce(filePath);
    const pythonSource = path.extname(filePath).toLowerCase() === ".py" || path.basename(filePath) === "pyproject.toml";
    const cacheHash = pythonSource ? pythonGraphCacheHash(contentHash) : contentHash;
    const current = cached.get(display);
    if (current?.contentHash === contentHash && current.cacheHash === cacheHash) {
      cachedFiles.push(display);
      return false;
    }
    return true;
  });
  const pythonPaths = changedNonTypescript
    .filter((filePath) => path.extname(filePath).toLowerCase() === ".py" || path.basename(filePath) === "pyproject.toml")
    .map((filePath) => normalizePath(path.relative(root, filePath)));
  const markdownPaths = changedNonTypescript.filter((filePath) => path.extname(filePath).toLowerCase() === ".md").map((filePath) => normalizePath(path.relative(root, filePath)));
  const packagePaths = changedNonTypescript.filter((filePath) => path.basename(filePath) === "package.json").map((filePath) => normalizePath(path.relative(root, filePath)));
  const python = await extractPython(root, pythonPaths, signal, config.limits.maxFileBytes, config.limits.maxOutputBytes, config.limits.commandTimeoutMs, onFacts);
  if (signal?.aborted) {
    return { facts: [], errors: Object.fromEntries(paths.map((filePath) => [normalizePath(filePath.replace(/^@/, "")), "graph scan aborted"])), cachedFiles: [] };
  }
  const packageJson = extractPackageJson(root, packagePaths);
  const typescript = extractTypescript(root, typescriptFiles, config, reusableProjects, cached, onFacts);
  const groups = [typescript.facts, python.facts, packageJson.facts, extractMarkdown(root, markdownPaths, config)];
  const facts: GraphFileFacts[] = [];
  for (const group of groups) {
    if (!group.length) continue;
    if (onFacts) onFacts(group);
    else facts.push(...group);
  }
  return { facts, errors: { ...errors, ...python.errors, ...packageJson.errors }, cachedFiles: [...cachedFiles, ...typescript.cachedFiles] };
}
