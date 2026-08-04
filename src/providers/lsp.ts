import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

import type { AiSlopConfig } from "../core/config.ts";
import { createScanResult, fingerprint } from "../core/schema.ts";
import { SCHEMA_VERSION, type EvidenceRecord, type FindingDraft, type ScanResult, type SkippedFile } from "../types.ts";
import { safeProjectFile, sourceRange } from "./files.ts";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspDiagnostic {
  range: { start: LspPosition; end: LspPosition };
  severity?: number;
  code?: string | number | { value?: string | number };
  source?: string;
  message: string;
}

interface LspSymbol {
  name?: string;
  kind?: number;
  range?: { start: LspPosition; end: LspPosition };
  selectionRange?: { start: LspPosition; end: LspPosition };
  location?: { uri?: string; range?: { start: LspPosition; end: LspPosition } };
  children?: LspSymbol[];
}

const LANGUAGE_IDS: Record<string, string> = {
  ".c": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".go": "go",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".rs": "rust",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
};

function baseLanguage(languageId: string): string {
  if (languageId.startsWith("typescript") || languageId.startsWith("javascript")) return "typescript";
  if (languageId === "cpp") return "cpp";
  return languageId;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === "win32"
    ? ["PATH", "HOME", "TEMP", "TMP", "SYSTEMROOT", "LOCALAPPDATA", "APPDATA"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  return Object.fromEntries(names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])));
}

class LspConnection {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications = new Map<string, Array<(params: any) => void>>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private stderr = "";
  private closed = false;
  private readonly timeoutMs: number;

  constructor(command: string[], rootDir: string, timeoutMs: number, signal?: AbortSignal) {
    this.timeoutMs = timeoutMs;
    if (!command.length || command.some((part) => !part || part.includes("\0"))) throw new Error("invalid LSP command");
    this.process = spawn(command[0], command.slice(1), {
      cwd: rootDir,
      env: safeEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.process.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-64 * 1024);
    });
    this.process.on("error", (error) => this.failAll(error));
    this.process.on("exit", (code, signalName) => {
      if (!this.closed) this.failAll(new Error(`LSP exited (${String(code ?? signalName)}): ${this.stderr.slice(-2_000)}`));
    });
    signal?.addEventListener("abort", () => this.abort(), { once: true });
  }

  on(method: string, listener: (params: any) => void): void {
    this.notifications.set(method, [...(this.notifications.get(method) ?? []), listener]);
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<any> {
    if (this.closed) return Promise.reject(new Error("LSP connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request("shutdown", null, Math.min(this.timeoutMs, 2_000));
      this.notify("exit", null);
    } catch {
      // A server that cannot shut down cleanly is terminated below.
    }
    this.closed = true;
    this.process.kill("SIGTERM");
    this.failAll(new Error("LSP connection closed"));
  }

  diagnostic(): string {
    return this.stderr.trim().slice(-2_000);
  }

  private abort(): void {
    if (this.closed) return;
    this.closed = true;
    this.process.kill("SIGTERM");
    this.failAll(new Error("LSP operation cancelled"));
  }

  private write(message: JsonRpcMessage): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.process.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.process.stdin.write(body);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 16 * 1024 * 1024) {
      this.abort();
      return;
    }
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) {
        this.abort();
        return;
      }
      const messageEnd = headerEnd + 4 + length;
      if (this.buffer.length < messageEnd) return;
      const body = this.buffer.subarray(headerEnd + 4, messageEnd).toString("utf8");
      this.buffer = this.buffer.subarray(messageEnd);
      try {
        this.dispatch(JSON.parse(body) as JsonRpcMessage);
      } catch {
        this.abort();
        return;
      }
    }
  }

  private dispatch(message: JsonRpcMessage): void {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`LSP ${message.error.code ?? "error"}: ${message.error.message ?? "unknown"}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) for (const listener of this.notifications.get(message.method) ?? []) listener(message.params);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("LSP operation cancelled"));
      },
      { once: true },
    );
  });
}

function flattenSymbols(symbols: unknown): LspSymbol[] {
  if (!Array.isArray(symbols)) return [];
  return symbols.flatMap((symbol: LspSymbol) => [symbol, ...flattenSymbols(symbol.children)]);
}

function diagnosticPolicy(severity: number | undefined): Pick<FindingDraft, "classification" | "confidence" | "risk"> {
  if (severity === 1) return { classification: "defect", confidence: "C2", risk: "R2" };
  if (severity === 2) return { classification: "context_conflict", confidence: "C2", risk: "R2" };
  return { classification: "assurance_gap", confidence: "C1", risk: "R1" };
}

function lspCode(code: LspDiagnostic["code"]): string {
  if (code && typeof code === "object") return String(code.value ?? "unidentified");
  return String(code ?? "unidentified");
}

async function collectLanguage(
  rootDir: string,
  language: string,
  files: Array<{ filePath: string; source: string; absolutePath: string; languageId: string }>,
  command: string[],
  config: AiSlopConfig,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const connection = new LspConnection(command, rootDir, config.limits.commandTimeoutMs, signal);
  const diagnostics = new Map<string, LspDiagnostic[]>();
  connection.on("textDocument/publishDiagnostics", (params) => {
    if (typeof params?.uri === "string" && Array.isArray(params.diagnostics)) diagnostics.set(params.uri, params.diagnostics);
  });
  const findings: FindingDraft[] = [];
  const evidenceRecords: EvidenceRecord[] = [];
  const skipped: SkippedFile[] = [];
  let serverVersion = "unknown";
  try {
    const initialized = await connection.request("initialize", {
      processId: process.pid,
      clientInfo: { name: "pi-ai-slop-review", version: "1" },
      rootUri: pathToFileURL(rootDir).toString(),
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          references: {},
          definition: {},
          callHierarchy: {},
          diagnostic: {},
        },
      },
      workspaceFolders: [{ uri: pathToFileURL(rootDir).toString(), name: path.basename(rootDir) }],
    });
    serverVersion = String(initialized?.serverInfo?.version ?? initialized?.serverInfo?.name ?? "unknown");
    connection.notify("initialized", {});
    for (const file of files) {
      const uri = pathToFileURL(file.absolutePath).toString();
      connection.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: file.languageId, version: 1, text: file.source },
      });
    }
    await delay(300, signal);
    for (const file of files) {
      const uri = pathToFileURL(file.absolutePath).toString();
      try {
        const pulled = await connection.request("textDocument/diagnostic", { textDocument: { uri } }, Math.min(5_000, config.limits.commandTimeoutMs));
        if (Array.isArray(pulled?.items)) diagnostics.set(uri, pulled.items);
      } catch {
        // Push diagnostics remain authoritative when pull diagnostics are unsupported.
      }
      let symbols: LspSymbol[] = [];
      try {
        symbols = flattenSymbols(await connection.request("textDocument/documentSymbol", { textDocument: { uri } }));
      } catch {
        // Symbol support is optional in LSP.
      }
      if (symbols.length) {
        const range = sourceRange(file.filePath, file.source, 1, 1, 1, 1);
        evidenceRecords.push({
          schemaVersion: SCHEMA_VERSION,
          id: fingerprint("evidence", { filePath: file.filePath, language, symbols: symbols.map((item) => item.name) }),
          providerId: `lsp-${language}`,
          providerVersion: serverVersion,
          kind: "reference",
          summary: `language server returned ${symbols.length} document symbol(s)`,
          strength: "C2",
          source: range,
          details: { symbols: symbols.slice(0, 500).map((item) => ({ name: item.name, kind: item.kind, range: item.range ?? item.location?.range })) },
        });
      }
      for (const symbol of symbols.slice(0, 50)) {
        const position = symbol.selectionRange?.start ?? symbol.location?.range?.start ?? symbol.range?.start;
        if (!position) continue;
        const details: Record<string, unknown> = { symbol: symbol.name };
        for (const [key, method, params] of [
          ["references", "textDocument/references", { textDocument: { uri }, position, context: { includeDeclaration: true } }],
          ["definitions", "textDocument/definition", { textDocument: { uri }, position }],
          ["callHierarchy", "textDocument/prepareCallHierarchy", { textDocument: { uri }, position }],
        ] as const) {
          try {
            const response = await connection.request(method, params, Math.min(3_000, config.limits.commandTimeoutMs));
            details[key] = Array.isArray(response) ? response.length : response ? 1 : 0;
          } catch {
            details[key] = "unsupported";
          }
        }
        const positionRange = sourceRange(file.filePath, file.source, position.line + 1, position.character + 1, position.line + 1, position.character + 1);
        evidenceRecords.push({
          schemaVersion: SCHEMA_VERSION,
          id: fingerprint("evidence", { filePath: file.filePath, language, position, symbol: symbol.name, details }),
          providerId: `lsp-${language}`,
          providerVersion: serverVersion,
          kind: "reference",
          summary: `language server context for symbol '${symbol.name ?? "unknown"}'`,
          strength: "C2",
          source: positionRange,
          details,
        });
      }
    }
    await delay(150, signal);
    for (const file of files) {
      const uri = pathToFileURL(file.absolutePath).toString();
      for (const rawDiagnostic of diagnostics.get(uri) ?? []) {
        const diagnostic = rawDiagnostic as Partial<LspDiagnostic>;
        const range = diagnostic.range;
        const positions = [
          range?.start?.line,
          range?.start?.character,
          range?.end?.line,
          range?.end?.character,
        ];
        if (
          !range ||
          typeof diagnostic.message !== "string" ||
          positions.some((value) => typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
        ) {
          skipped.push({
            filePath: file.filePath,
            reason: `language server emitted a malformed diagnostic`,
            providerId: `lsp-${language}`,
          });
          continue;
        }
        const source = sourceRange(
          file.filePath,
          file.source,
          range.start.line + 1,
          range.start.character + 1,
          range.end.line + 1,
          range.end.character + 1,
        );
        const code = lspCode(diagnostic.code);
        findings.push({
          ...source,
          anchor: `lsp:${language}:${diagnostic.source ?? "server"}:${code}:${diagnostic.message}`,
          ruleId: `lsp.${language}.${diagnostic.source ?? "server"}.${code}`,
          ...diagnosticPolicy(diagnostic.severity),
          maximumAction: "observe",
          message: diagnostic.message,
          evidence: [`trusted configured ${language} language server emitted this diagnostic`],
          counterEvidence: [],
          unknown: ["language-server configuration and repository intent may affect this diagnostic"],
        });
      }
    }
  } catch (error) {
    skipped.push({ filePath: `<lsp:${language}>`, reason: error instanceof Error ? error.message : String(error), providerId: `lsp-${language}` });
  } finally {
    await connection.close();
  }
  const stderr = connection.diagnostic();
  if (stderr) skipped.push({ filePath: `<lsp:${language}:stderr>`, reason: stderr, providerId: `lsp-${language}` });
  return createScanResult({
    engine: "provider-federation",
    engineVersion: `${language} LSP ${serverVersion}`,
    rootDir,
    providerId: `lsp-${language}`,
    providerVersion: serverVersion,
    providerCapabilities: ["diagnostics", "symbols", "references", "call-hierarchy", "types"],
    evidenceRecords,
    scannedFiles: files.map((file) => file.filePath),
    findings,
    skipped,
  });
}

export async function collectLspEvidence(
  rootDir: string,
  paths: string[],
  config: AiSlopConfig,
  trustedProject: boolean,
  signal?: AbortSignal,
): Promise<ScanResult[]> {
  const grouped = new Map<string, Array<{ filePath: string; source: string; absolutePath: string; languageId: string }>>();
  for (const rawPath of paths) {
    const file = safeProjectFile(rootDir, rawPath);
    if (!file) continue;
    const languageId = LANGUAGE_IDS[path.extname(file.filePath).toLowerCase()];
    if (!languageId) continue;
    const language = baseLanguage(languageId);
    grouped.set(language, [...(grouped.get(language) ?? []), { ...file, languageId }]);
  }
  const results: ScanResult[] = [];
  const languages = [...grouped.entries()];
  for (let index = 0; index < languages.length; index += 2) {
    const batch = await Promise.all(languages.slice(index, index + 2).map(async ([language, files]) => {
      const command = config.execution.lspServers[language];
      if (!command) return undefined;
      if (!trustedProject || !config.execution.trusted) {
        return createScanResult({
          engine: "provider-federation",
          engineVersion: `${language} LSP blocked`,
          rootDir,
          providerId: `lsp-${language}`,
          providerVersion: "unknown",
          providerCapabilities: ["diagnostics", "symbols", "references", "call-hierarchy", "types"],
          scannedFiles: [],
          findings: [],
          skipped: [{ filePath: `<lsp:${language}>`, reason: "LSP execution requires both trusted project context and execution.trusted configuration", providerId: `lsp-${language}` }],
        });
      }
      return collectLanguage(rootDir, language, files, command, config, signal);
    }));
    results.push(...batch.filter((result): result is ScanResult => result !== undefined));
  }
  return results;
}
