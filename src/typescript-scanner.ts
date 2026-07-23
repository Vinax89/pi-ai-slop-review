import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import * as ts from "typescript";

import { isInside, normalizePath } from "./core/paths.ts";
import { createScanResult } from "./core/schema.ts";
import { canonicalSymbol } from "./core/typescript.ts";
import type { FindingConfidence, FindingDraft, ScanResult, SkippedFile } from "./types.ts";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const MAX_FILE_BYTES = 1024 * 1024;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/, ""), `node:${name.replace(/^node:/, "")}`]));
const LOG_METHODS = new Set(["debug", "error", "exception", "info", "log", "trace", "warn", "warning"]);

interface Project {
  program: ts.Program;
  checker: ts.TypeChecker;
  options: ts.CompilerOptions;
  configPath?: string;
  configHasErrors: boolean;
}

interface WrapperCandidate {
  sourceFile: ts.SourceFile;
  node: ts.FunctionLikeDeclaration;
  name: ts.Identifier;
  call: ts.CallExpression;
  symbol: ts.Symbol;
  exported: boolean;
  boundaryTags: string[];
  hasExplicitReturnType: boolean;
  overloadCount: number;
  calleeResolved: boolean;
  thisBoundTarget: boolean;
  directCalls: number;
  nonCallReferences: number;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function findProjectConfig(root: string, filePath: string): string | undefined {
  let directory = path.dirname(filePath);
  while (isInside(root, directory)) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
    if (directory === root) break;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function createProject(files: string[], configPath?: string): Project {
  let options: ts.CompilerOptions;
  let rootNames: string[];
  let configHasErrors = false;

  if (configPath) {
    const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
    if (loaded.error) {
      configHasErrors = true;
      options = defaultCompilerOptions();
      rootNames = files;
    } else {
      const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(configPath));
      configHasErrors = parsed.errors.length > 0;
      options = { ...parsed.options, allowJs: true, noEmit: true };
      rootNames = [...new Set([...parsed.fileNames, ...files])];
    }
  } else {
    options = defaultCompilerOptions();
    rootNames = files;
  }

  const program = ts.createProgram({ rootNames, options });
  return {
    program,
    checker: program.getTypeChecker(),
    options,
    configPath,
    configHasErrors,
  };
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  };
}

function nodeLocation(sourceFile: ts.SourceFile, node: ts.Node) {
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  return { start, end, line: position.line + 1, column: position.character + 1 };
}

function finding(
  sourceFile: ts.SourceFile,
  sourceHash: string,
  root: string,
  node: ts.Node,
  values: Omit<FindingDraft, "filePath" | "line" | "column" | "start" | "end" | "sourceHash">,
): FindingDraft {
  return {
    ...values,
    filePath: normalizePath(path.relative(root, sourceFile.fileName)),
    ...nodeLocation(sourceFile, node),
    sourceHash,
  };
}

function isGenerated(filePath: string, text: string): boolean {
  if (/(?:^|\/)(?:dist|build|coverage|node_modules|vendor|generated)(?:\/|$)/i.test(normalizePath(filePath))) {
    return true;
  }
  return /(?:@generated|generated file|do not edit)/i.test(text.slice(0, 500));
}

function isExported(checker: ts.TypeChecker, sourceFile: ts.SourceFile, name: ts.Identifier, node: ts.Node): boolean {
  const container = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent)
    ? node.parent.parent
    : node;
  if (ts.canHaveModifiers(container)) {
    const modifiers = ts.getModifiers(container) ?? [];
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      return true;
    }
  }

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const target = canonicalSymbol(checker, checker.getSymbolAtLocation(name));
  if (!moduleSymbol || !target) return false;
  return checker.getExportsOfModule(moduleSymbol).some((entry) => canonicalSymbol(checker, entry) === target);
}

function hasSimpleDelegationTarget(expression: ts.LeftHandSideExpression): boolean {
  let target: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression;
  return ts.isIdentifier(target) || target.kind === ts.SyntaxKind.ThisKeyword || target.kind === ts.SyntaxKind.SuperKeyword;
}

function wrapperBody(node: ts.FunctionLikeDeclaration): ts.CallExpression | undefined {
  if (!node.body || node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return undefined;
  if (node.asteriskToken || node.typeParameters?.length) return undefined;
  if (node.parameters.some((parameter) => !ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken)) {
    return undefined;
  }

  let expression: ts.Expression | undefined;
  if (ts.isBlock(node.body)) {
    if (node.body.statements.length !== 1) return undefined;
    const statement = node.body.statements[0];
    if (!ts.isReturnStatement(statement) || !statement.expression) return undefined;
    expression = statement.expression;
  } else {
    expression = node.body;
  }
  if (!ts.isCallExpression(expression) || expression.typeArguments?.length || expression.questionDotToken) return undefined;
  if (!hasSimpleDelegationTarget(expression.expression) || expression.arguments.length !== node.parameters.length) return undefined;

  for (let index = 0; index < node.parameters.length; index += 1) {
    const parameter = node.parameters[index];
    const argument = expression.arguments[index];
    if (!ts.isIdentifier(parameter.name) || !ts.isIdentifier(argument) || parameter.name.text !== argument.text) {
      return undefined;
    }
  }
  return expression;
}

function functionName(node: ts.Node): { node: ts.FunctionLikeDeclaration; name: ts.Identifier } | undefined {
  if (ts.isFunctionDeclaration(node) && node.name && node.body) return { node, name: node.name };
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return { node: node.initializer, name: node.name };
  }
  return undefined;
}

function collectWrappers(project: Project, requestedFiles: Set<string>): WrapperCandidate[] {
  const wrappers: WrapperCandidate[] = [];
  for (const sourceFile of project.program.getSourceFiles()) {
    if (!requestedFiles.has(path.resolve(sourceFile.fileName))) continue;
    const visit = (node: ts.Node): void => {
      const candidate = functionName(node);
      if (candidate) {
        const call = wrapperBody(candidate.node);
        const symbol = canonicalSymbol(project.checker, project.checker.getSymbolAtLocation(candidate.name));
        if (call && symbol) {
          const calleeSymbol = canonicalSymbol(project.checker, project.checker.getSymbolAtLocation(call.expression));
          if (calleeSymbol === symbol) {
            ts.forEachChild(node, visit);
            return;
          }
          const boundaryTags = ts.getJSDocTags(candidate.node)
            .map((tag) => tag.tagName.text)
            .filter((tag) => ["deprecated", "public", "internal", "override"].includes(tag));
          wrappers.push({
            sourceFile,
            node: candidate.node,
            name: candidate.name,
            call,
            symbol,
            exported: isExported(project.checker, sourceFile, candidate.name, node),
            boundaryTags,
            hasExplicitReturnType: Boolean(candidate.node.type),
            overloadCount: symbol.declarations?.length ?? 1,
            calleeResolved: Boolean(calleeSymbol),
            thisBoundTarget: call.expression.getText(sourceFile).includes("this."),
            directCalls: 0,
            nonCallReferences: 0,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return wrappers;
}

function classifyWrapperReferences(project: Project, root: string, wrappers: WrapperCandidate[]): void {
  const bySymbol = new Map(wrappers.map((wrapper) => [wrapper.symbol, wrapper]));
  for (const sourceFile of project.program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || !isInside(root, path.resolve(sourceFile.fileName))) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const symbol = canonicalSymbol(project.checker, project.checker.getSymbolAtLocation(node));
        const wrapper = symbol ? bySymbol.get(symbol) : undefined;
        if (wrapper && node !== wrapper.name) {
          if (ts.isCallExpression(node.parent) && node.parent.expression === node) wrapper.directCalls += 1;
          else wrapper.nonCallReferences += 1;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function isLogStatement(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false;
  const callee = statement.expression.expression;
  return ts.isPropertyAccessExpression(callee) && LOG_METHODS.has(callee.name.text.toLowerCase());
}

function isSafeLookingFallback(expression: ts.Expression): boolean {
  if (
    ts.isNumericLiteral(expression) ||
    ts.isStringLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(expression)) return expression.text === "undefined";
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.length === 0;
  if (ts.isObjectLiteralExpression(expression)) {
    if (expression.properties.length === 0) return true;
    return expression.properties.some((property) => {
      if (!ts.isPropertyAssignment(property)) return false;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : "";
      if (!/^(?:ok|success|status)$/i.test(name)) return false;
      const value = property.initializer;
      return value.kind === ts.SyntaxKind.TrueKeyword || (ts.isStringLiteral(value) && /^(?:ok|success)$/i.test(value.text));
    });
  }
  return false;
}

function catchFallback(block: ts.Block): ts.ReturnStatement | undefined {
  if (block.statements.length === 0) return undefined;
  const last = block.statements[block.statements.length - 1];
  if (!ts.isReturnStatement(last) || !last.expression || !isSafeLookingFallback(last.expression)) return undefined;
  return block.statements.slice(0, -1).every(isLogStatement) ? last : undefined;
}

function explicitPredicateOutcome(catchClause: ts.CatchClause, fallback: ts.ReturnStatement): boolean {
  if (fallback.expression?.kind !== ts.SyntaxKind.TrueKeyword && fallback.expression?.kind !== ts.SyntaxKind.FalseKeyword) return false;
  let current: ts.Node | undefined = catchClause.parent;
  let name = "";
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) {
      name = current.name.text;
      break;
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) {
      name = current.parent.name.text;
      break;
    }
    current = current.parent;
  }
  if (!/^(?:is|has|can|supports|exists)[A-Z_]/.test(name)) return false;
  const opposite = fallback.expression.kind === ts.SyntaxKind.TrueKeyword ? ts.SyntaxKind.FalseKeyword : ts.SyntaxKind.TrueKeyword;
  const tryStatement = catchClause.parent;
  if (!ts.isTryStatement(tryStatement)) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found || (node !== tryStatement.tryBlock && ts.isFunctionLike(node))) return;
    if (ts.isReturnStatement(node) && node.expression?.kind === opposite) found = true;
    else ts.forEachChild(node, visit);
  };
  visit(tryStatement.tryBlock);
  return found;
}

function structuralAnchor(node: ts.Node, prefix: string): string {
  const parts: number[] = [];
  let current: ts.Node | undefined = node;
  while (current?.parent) {
    const siblings: ts.Node[] = [];
    current.parent.forEachChild((child) => siblings.push(child));
    parts.push(Math.max(0, siblings.indexOf(current)));
    current = current.parent;
  }
  return `${prefix}:${parts.reverse().join(".")}`;
}

function scanCatchClauses(sourceFile: ts.SourceFile, sourceHash: string, root: string): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) {
      const fallback = catchFallback(node.block);
      if (fallback && !explicitPredicateOutcome(node, fallback)) {
        findings.push(
          finding(sourceFile, sourceHash, root, fallback, {
            anchor: structuralAnchor(node, "catch-fallback"),
            ruleId: "data.hidden-catch-fallback",
            classification: "context_conflict",
            confidence: "C2",
            risk: "R3",
            maximumAction: "observe",
            message: "Catch clause converts failure into a safe-looking return value",
            evidence: ["failure path ends in a literal or empty success-looking fallback"],
            counterEvidence: [],
            unknown: ["caller contract and whether the fallback is intentionally visible"],
          }),
        );
      } else if (node.block.statements.length === 0 || node.block.statements.every(isLogStatement)) {
        const logOnly = node.block.statements.length > 0;
        findings.push(
          finding(sourceFile, sourceHash, root, node, {
            anchor: structuralAnchor(node, "catch-suppressed"),
            ruleId: "errors.suppressed",
            classification: "context_conflict",
            confidence: "C2",
            risk: "R2",
            maximumAction: "observe",
            message: logOnly ? "Catch clause only logs before control continues" : "Catch clause is empty",
            evidence: [logOnly ? "all catch statements are logger-like calls" : "catch body has no executable statements"],
            counterEvidence: [],
            unknown: ["whether this is an intentional best-effort boundary"],
          }),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function scanImports(project: Project, sourceFile: ts.SourceFile, sourceHash: string, root: string): FindingDraft[] {
  const findings: FindingDraft[] = [];
  const semanticDiagnostics = project.program.getSemanticDiagnostics(sourceFile);
  const visit = (node: ts.Node): void => {
    let specifier: ts.StringLiteralLike | undefined;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifier = node.moduleSpecifier;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      specifier = node.moduleReference.expression;
    }

    if (specifier) {
      const spec = specifier.text;
      const isRuntimeBuiltin = BUILTINS.has(spec) || /^(?:https?|bun|deno):/.test(spec);
      const symbol = canonicalSymbol(project.checker, project.checker.getSymbolAtLocation(specifier));
      const resolved = isRuntimeBuiltin
        ? true
        : Boolean(ts.resolveModuleName(spec, sourceFile.fileName, project.options, ts.sys).resolvedModule || symbol);
      if (!resolved) {
        const location = nodeLocation(sourceFile, specifier);
        const compilerConfirms = semanticDiagnostics.some(
          (diagnostic) =>
            diagnostic.code === 2307 &&
            diagnostic.start !== undefined &&
            diagnostic.start <= location.end &&
            diagnostic.start + (diagnostic.length ?? 0) >= location.start,
        );
        const confidence: FindingConfidence = compilerConfirms && project.configPath && !project.configHasErrors ? "C3" : "C2";
        findings.push(
          finding(sourceFile, sourceHash, root, specifier, {
            anchor: `module:${spec}`,
            ruleId: "dependency.unresolved",
            classification: "defect",
            confidence,
            risk: "R2",
            maximumAction: "observe",
            message: `Module '${spec}' is unresolved under the active TypeScript configuration`,
            evidence: [compilerConfirms ? "TypeScript emitted TS2307" : "module resolver and type checker found no target"],
            counterEvidence: [],
            unknown: project.configPath ? [] : ["no tsconfig/jsconfig was available; workspace aliases may be incomplete"],
          }),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function wrapperFindings(project: Project, root: string, wrappers: WrapperCandidate[], hashes: Map<string, string>): FindingDraft[] {
  classifyWrapperReferences(project, root, wrappers);
  return wrappers.map((wrapper) => {
    const vetoes = [
      ...(wrapper.exported ? ["symbol is exported"] : []),
      ...(wrapper.boundaryTags.length ? [`JSDoc boundary tags: ${wrapper.boundaryTags.join(", ")}`] : []),
      ...(wrapper.hasExplicitReturnType ? ["wrapper declares an explicit return contract"] : []),
      ...(wrapper.overloadCount > 1 ? [`symbol has ${wrapper.overloadCount} declarations or overloads`] : []),
      ...(!wrapper.calleeResolved ? ["delegated target did not resolve to a symbol"] : []),
      ...(wrapper.thisBoundTarget ? ["delegated target is bound through this"] : []),
      ...(wrapper.nonCallReferences ? [`${wrapper.nonCallReferences} non-call reference(s)`] : []),
    ];
    const canPropose = Boolean(project.configPath) && vetoes.length === 0;
    const callee = wrapper.call.expression.getText(wrapper.sourceFile);
    return finding(wrapper.sourceFile, hashes.get(path.resolve(wrapper.sourceFile.fileName)) ?? "", root, wrapper.node, {
      anchor: `function:${wrapper.name.text}`,
      ruleId: "structure.pass-through-wrapper",
      classification: "waste_candidate",
      confidence: canPropose ? "C2" : "C1",
      risk: "R2",
      maximumAction: canPropose ? "propose" : "observe",
      message: `Function '${wrapper.name.text}' forwards unchanged arguments to '${callee}'`,
      evidence: [
        "AST confirms one delegated call with identity argument mapping",
        `${wrapper.directCalls} direct call reference(s) found in the semantic project`,
      ],
      counterEvidence: vetoes,
      unknown: project.configPath ? ["dynamic or framework registration cannot be disproven"] : ["project-wide callers are incomplete without tsconfig/jsconfig"],
    });
  });
}

function resolveFiles(rootDir: string, inputs: string[]): { files: string[]; skipped: SkippedFile[] } {
  const root = realpathSync(rootDir);
  const files: string[] = [];
  const skipped: SkippedFile[] = [];
  for (const input of inputs) {
    const resolved = path.resolve(root, input.replace(/^@/, ""));
    const display = normalizePath(path.relative(root, resolved));
    if (!existsSync(resolved)) {
      skipped.push({ filePath: display, reason: "file does not exist" });
      continue;
    }
    const real = realpathSync(resolved);
    if (!isInside(root, real)) {
      skipped.push({ filePath: display, reason: "path resolves outside the project root" });
      continue;
    }
    const stats = statSync(real);
    if (!stats.isFile()) {
      skipped.push({ filePath: display, reason: "path is not a file" });
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(path.extname(real).toLowerCase())) {
      skipped.push({ filePath: display, reason: "unsupported file extension" });
      continue;
    }
    if (stats.size > MAX_FILE_BYTES) {
      skipped.push({ filePath: display, reason: `file exceeds ${MAX_FILE_BYTES} bytes` });
      continue;
    }
    files.push(real);
  }
  return { files: [...new Set(files)], skipped };
}

export function scanTypeScriptFiles(rootDir: string, inputPaths: string[]): ScanResult {
  const root = realpathSync(rootDir);
  const resolved = resolveFiles(root, inputPaths);
  const findings: FindingDraft[] = [];
  const scannedFiles: string[] = [];
  const skipped = [...resolved.skipped];
  const groups = new Map<string, string[]>();

  for (const file of resolved.files) {
    const configPath = findProjectConfig(root, file);
    const key = configPath ?? "<none>";
    groups.set(key, [...(groups.get(key) ?? []), file]);
  }

  for (const [key, files] of groups) {
    const project = createProject(files, key === "<none>" ? undefined : key);
    const hashes = new Map<string, string>();
    const validFiles = new Set<string>();

    for (const file of files) {
      const sourceFile = project.program.getSourceFile(file);
      const display = normalizePath(path.relative(root, file));
      if (!sourceFile) {
        skipped.push({ filePath: display, reason: "TypeScript program did not include the file" });
        continue;
      }
      const text = readFileSync(file, "utf8");
      if (isGenerated(display, text)) {
        skipped.push({ filePath: display, reason: "generated or vendor-like file" });
        continue;
      }
      const syntaxErrors = project.program.getSyntacticDiagnostics(sourceFile);
      if (syntaxErrors.length > 0) {
        skipped.push({ filePath: display, reason: "file has TypeScript syntax diagnostics" });
        continue;
      }
      const sourceHash = hashText(text);
      hashes.set(path.resolve(file), sourceHash);
      validFiles.add(path.resolve(file));
      scannedFiles.push(display);
      findings.push(...scanImports(project, sourceFile, sourceHash, root));
      findings.push(...scanCatchClauses(sourceFile, sourceHash, root));
    }

    const wrappers = collectWrappers(project, validFiles);
    findings.push(...wrapperFindings(project, root, wrappers, hashes));
  }

  return createScanResult({
    engine: "typescript-semantic",
    engineVersion: ts.version,
    rootDir: root,
    providerId: "typescript-semantic",
    providerVersion: ts.version,
    providerCapabilities: ["syntax", "types", "resolution", "symbols", "references", "diagnostics"],
    scannedFiles,
    findings,
    skipped,
  });
}
