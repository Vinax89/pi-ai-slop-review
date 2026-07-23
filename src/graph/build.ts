import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import * as ts from "typescript";

import type { AiSlopConfig } from "../core/config.ts";
import { fingerprint, normalizePath, sha256 } from "../core/schema.ts";
import { canonicalSymbol } from "../core/typescript.ts";
import { safeProjectFile } from "../providers/files.ts";
import type { GraphEdge, GraphFileFacts, GraphNode, GraphNodeKind } from "./types.ts";

const execFileAsync = promisify(execFile);
const PYTHON_HELPER = fileURLToPath(new URL("../python_graph_helper.py", import.meta.url));
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

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

function configForFile(rootDir: string, filePath: string): { rootNames: string[]; options: ts.CompilerOptions } {
  const configPath = ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, "tsconfig.json") ?? ts.findConfigFile(path.dirname(filePath), ts.sys.fileExists, "jsconfig.json");
  if (!configPath || !normalizePath(configPath).startsWith(`${normalizePath(rootDir)}/`)) {
    return {
      rootNames: [filePath],
      options: {
        allowJs: true,
        checkJs: false,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
      },
    };
  }
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) return { rootNames: [filePath], options: {} };
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(configPath));
  return { rootNames: [...new Set([...parsed.fileNames, filePath])], options: { ...parsed.options, allowJs: true } };
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

function extractTypescript(rootDir: string, inputFiles: string[], config: AiSlopConfig): GraphFileFacts[] {
  const groups = new Map<string, string[]>();
  for (const filePath of inputFiles) {
    const project = configForFile(rootDir, filePath);
    const key = fingerprint("ts-project", { options: project.options, rootNames: project.rootNames });
    groups.set(key, [...(groups.get(key) ?? []), filePath]);
  }
  const facts: GraphFileFacts[] = [];
  for (const files of groups.values()) {
    const project = configForFile(rootDir, files[0]);
    const program = ts.createProgram({ rootNames: [...new Set([...project.rootNames, ...files])], options: project.options });
    const checker = program.getTypeChecker();
    for (const absolutePath of files) {
      const sourceFile = program.getSourceFile(absolutePath);
      if (!sourceFile) continue;
      const source = readFileSync(absolutePath, "utf8");
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
          const resolved = ts.resolveModuleName(specifier, absolutePath, project.options, ts.sys).resolvedModule?.resolvedFileName;
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
      facts.push({ filePath, sourceHash: sha256(source), language: "typescript", nodes: [...uniqueNodes.values()], edges: uniqueEdges });
    }
  }
  return facts;
}

interface PythonGraphOutput {
  files: Record<string, { nodes: Array<Omit<GraphNode, "id" | "filePath">>; edges: Array<{ from: string; to: string; kind: GraphEdge["kind"]; confidence: GraphEdge["confidence"]; metadata: Record<string, unknown> }> }>;
  errors: Record<string, string>;
}

async function extractPython(rootDir: string, paths: string[], signal?: AbortSignal): Promise<{ facts: GraphFileFacts[]; errors: Record<string, string> }> {
  if (!paths.length) return { facts: [], errors: {} };
  const { stdout } = await execFileAsync(process.env.PI_AI_SLOP_PYTHON ?? "python3", ["-I", "-S", PYTHON_HELPER, rootDir, ...paths], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    signal,
  });
  const parsed = JSON.parse(stdout) as PythonGraphOutput;
  const facts = Object.entries(parsed.files).map(([filePath, raw]) => {
    const source = readFileSync(path.join(rootDir, filePath), "utf8");
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
      const toId = byQualified.get(rawTarget) ?? byName.get(rawTarget.split(".").at(-1) ?? rawTarget) ?? fingerprint("graph-python-target", { rawTarget });
      return edge(filePath, fromId, toId, rawEdge.kind, rawEdge.confidence, rawEdge.metadata);
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
    return { filePath, sourceHash: sha256(source), language: path.basename(filePath) === "pyproject.toml" ? "toml" : "python", nodes, edges };
  });
  return { facts, errors: parsed.errors };
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
    return [{ filePath: file.filePath, sourceHash: sha256(file.source), language: "json", nodes, edges }];
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
      return [{ filePath: file.filePath, sourceHash: sha256(file.source), language: "markdown", nodes, edges }];
    }
    rootNode.kind = "specification";
    const headingPattern = /^(#{1,6})\s+(.+)$/gm;
    for (const match of file.source.matchAll(headingPattern)) {
      const name = match[2].trim();
      const requirement = /\b(?:REQ|OBL|ADR|R)[-_ ]?\d+\b/i.test(name);
      const kind: GraphNodeKind = requirement ? "requirement" : "specification";
      const node: GraphNode = {
        id: nodeId(file.filePath, kind, name),
        filePath: file.filePath,
        kind,
        name,
        qualifiedName: name,
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
        exported: false,
        metadata: { headingLevel: match[1].length },
      };
      nodes.push(node);
      edges.push(edge(file.filePath, rootNode.id, node.id, "contains", "C3"));
      const sectionEnd = file.source.indexOf("\n#", node.end);
      const section = file.source.slice(node.end, sectionEnd < 0 ? undefined : sectionEnd);
      for (const pathMatch of section.matchAll(/`([^`]+\.[A-Za-z0-9]+)`|\[[^\]]+\]\(([^)]+)\)/g)) {
        const targetPath = pathMatch[1] ?? pathMatch[2];
        if (!targetPath || /^https?:/.test(targetPath)) continue;
        const target = safeProjectFile(rootDir, path.resolve(rootDir, path.dirname(file.filePath), targetPath));
        if (target) edges.push(edge(file.filePath, node.id, nodeId(target.filePath, "file", target.filePath), "governs", "C2", { targetPath: target.filePath }));
      }
    }
    return [{ filePath: file.filePath, sourceHash: sha256(file.source), language: "markdown", nodes, edges }];
  });
}

export async function buildGraphFacts(
  rootDir: string,
  paths: string[],
  config: AiSlopConfig,
  signal?: AbortSignal,
): Promise<{ facts: GraphFileFacts[]; errors: Record<string, string> }> {
  const root = realpathSync(rootDir);
  const valid = paths.flatMap((rawPath) => {
    const absolute = path.resolve(root, rawPath.replace(/^@/, ""));
    if (!existsSync(absolute)) return [];
    const real = realpathSync(absolute);
    const stats = statSync(real);
    if (!normalizePath(real).startsWith(`${normalizePath(root)}/`) || !stats.isFile() || stats.size > config.limits.maxFileBytes) return [];
    return [real];
  });
  const typescriptFiles = valid.filter((filePath) => TYPESCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase()));
  const pythonPaths = valid
    .filter((filePath) => path.extname(filePath).toLowerCase() === ".py" || path.basename(filePath) === "pyproject.toml")
    .map((filePath) => normalizePath(path.relative(root, filePath)));
  const markdownPaths = valid.filter((filePath) => path.extname(filePath).toLowerCase() === ".md").map((filePath) => normalizePath(path.relative(root, filePath)));
  const packagePaths = valid.filter((filePath) => path.basename(filePath) === "package.json").map((filePath) => normalizePath(path.relative(root, filePath)));
  const python = await extractPython(root, pythonPaths, signal);
  const packageJson = extractPackageJson(root, packagePaths);
  return {
    facts: [
      ...extractTypescript(root, typescriptFiles, config),
      ...python.facts,
      ...packageJson.facts,
      ...extractMarkdown(root, markdownPaths, config),
    ],
    errors: { ...python.errors, ...packageJson.errors },
  };
}
