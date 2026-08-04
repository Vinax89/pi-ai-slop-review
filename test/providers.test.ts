import assert from "node:assert/strict";
import { existsSync, mkdtempSync, watch, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { DEFAULT_CONFIG, type AiSlopConfig } from "../src/core/config.ts";
import { collectLspEvidence } from "../src/providers/lsp.ts";
import { importAnalyzerReports } from "../src/providers/analyzer-reports.ts";
import { safeProjectFile } from "../src/providers/files.ts";
import { scanFiles } from "../src/scan.ts";
function root(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ai-slop-provider-"));
  writeFileSync(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true } }),
  );
  return directory;
}

function config(): AiSlopConfig {
  return structuredClone(DEFAULT_CONFIG);
}

function minimalLspServer(directory: string): string {
  const server = path.join(directory, "minimal-lsp.cjs");
  writeFileSync(server, String.raw`
const fs = require('node:fs');
if (process.argv[2]) fs.writeFileSync(process.argv[2], 'active');
let buffer = Buffer.alloc(0);
function send(id, result) {
  const body = Buffer.from(JSON.stringify({jsonrpc:'2.0', id, result}));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}
function dispatch(message) {
  if (message.method === 'initialize') {
    const peer = process.argv[3];
    if (!peer || fs.existsSync(peer)) return send(message.id, {serverInfo:{name:'minimal',version:'1'},capabilities:{}});
    const watcher = fs.watch(require('node:path').dirname(peer), () => {
      if (!fs.existsSync(peer)) return;
      watcher.close();
      send(message.id, {serverInfo:{name:'minimal',version:'1'},capabilities:{}});
    });
    return;
  }
  if (message.method === 'textDocument/diagnostic') return send(message.id, {items:[]});
  if (message.method === 'textDocument/documentSymbol') return send(message.id, []);
  if (message.method === 'shutdown') return send(message.id, null);
  if (message.method === 'exit') process.exit(0);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(buffer.subarray(0, end).toString().match(/Content-Length:\s*(\d+)/i)[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString();
    buffer = buffer.subarray(end + 4 + length);
    dispatch(JSON.parse(body));
  }
});
`);
  return server;
}

test("imports SARIF findings and rejects out-of-project locations", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "input.ts"), "eval('value');\n");
  writeFileSync(
    path.join(directory, "results.sarif"),
    JSON.stringify({
      version: "2.1.0",
      runs: [
        {
          tool: { driver: { name: "Example", semanticVersion: "1.2.3" } },
          results: [
            {
              ruleId: "no-eval",
              level: "error",
              message: { text: "Do not use eval" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "input.ts" }, region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 } } }],
              codeFlows: [{}],
              fixes: [{}],
            },
            {
              ruleId: "outside",
              level: "warning",
              message: { text: "Outside" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "../outside.ts" } } }],
            },
          ],
        },
      ],
    }),
  );
  const settings = config();
  settings.providers.sarif = ["results.sarif"];
  const result = await scanFiles(directory, ["input.ts"], undefined, "explicit", { config: settings });
  const finding = result.findings.find((item) => item.ruleId === "sarif.Example.no-eval");
  assert.equal(finding?.confidence, "C2");
  assert.match(finding?.evidence.join(" ") ?? "", /code flow/);
  assert.ok(result.skipped.some((item) => /no readable in-project/.test(item.reason)));
});

test("federation bounds evidence and serialized output", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "input.ts"), "export const value = 1;\n");
  const results = Array.from({ length: 200 }, (_, index) => ({
    ruleId: `rule-${index}`,
    level: "warning",
    message: { text: `${index}:${"x".repeat(1_000)}` },
    locations: [{ physicalLocation: { artifactLocation: { uri: "input.ts" }, region: { startLine: 1, startColumn: 1 } } }],
  }));
  writeFileSync(path.join(directory, "large.sarif"), JSON.stringify({
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "Large" } }, results }],
  }));
  const settings = config();
  settings.graph.enabled = false;
  settings.providers.sarif = ["large.sarif"];
  settings.limits.maxOutputBytes = 100_000;
  settings.limits.maxFindings = 500;

  const result = await scanFiles(directory, ["input.ts"], undefined, "explicit", { config: settings });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= settings.limits.maxOutputBytes);
  assert.equal(result.completeness?.status, "partial");
  assert.ok(result.skipped.some((item) => item.filePath === "<output>"));
});

test("malformed configured provider results make the federated scan partial", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "input.ts"), "const value = 1;\n");
  writeFileSync(path.join(directory, "broken.sarif"), JSON.stringify({
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "Broken" } },
      results: [{ message: { text: "broken URI" }, locations: [{ physicalLocation: { artifactLocation: { uri: "%" } } }] }],
    }],
  }));
  const settings = config();
  settings.providers.sarif = ["broken.sarif"];
  const result = await scanFiles(directory, ["input.ts"], undefined, "explicit", { config: settings });
  assert.equal(result.completeness?.status, "partial");
  assert.ok(result.providers.some((provider) => provider.id === "sarif" && provider.status === "completed"));
  assert.ok(result.skipped.some((item) => item.filePath === "%" && /no readable in-project/.test(item.reason)));
});

test("normalizes analyzer and coverage reports without applying upstream fixes", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "input.ts"), "const unused = 1;\n");
  writeFileSync(
    path.join(directory, "eslint.json"),
    JSON.stringify([{ filePath: path.join(directory, "input.ts"), messages: [{ ruleId: "no-unused-vars", severity: 2, message: "unused", line: 1, column: 7, endLine: 1, endColumn: 13, fix: { range: [0, 1], text: "" } }] }]),
  );
  writeFileSync(path.join(directory, "lcov.info"), `TN:\nSF:${path.join(directory, "input.ts")}\nDA:1,0\nend_of_record\n`);
  const settings = config();
  settings.providers.analyzerReports = [{ kind: "eslint", path: "eslint.json" }];
  settings.providers.coverageReports = [{ kind: "lcov", path: "lcov.info" }];
  const result = await scanFiles(directory, ["input.ts"], undefined, "explicit", { config: settings });
  const finding = result.findings.find((item) => item.ruleId === "analyzer.eslint.no-unused-vars");
  assert.equal(finding?.maximumAction, "observe");
  assert.match(finding?.evidence.join(" ") ?? "", /not applied/);
  const coverage = result.evidenceRecords.find((item) => item.providerId === "coverage-lcov");
  assert.equal(coverage?.details?.total, 1);
  assert.deepEqual(coverage?.details?.missingLines, [1]);
});

test("coverage.py invalid line values are skipped without false 0/0 evidence", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "valid.py"), "value = 1\n");
  writeFileSync(path.join(directory, "invalid.py"), "value = 2\n");
  writeFileSync(
    path.join(directory, "coverage.json"),
    JSON.stringify({
      files: {
        "valid.py": {
          executed_lines: [1],
          missing_lines: [2],
          summary: { num_statements: 2, covered_lines: 1, percent_covered: 50 },
        },
        "invalid.py": { executed_lines: ["not-a-line"], missing_lines: [] },
      },
    }),
  );
  const settings = config();
  settings.providers.coverageReports = [{ kind: "coverage-py-json", path: "coverage.json" }];
  const result = await scanFiles(directory, ["valid.py", "invalid.py"], undefined, "explicit", { config: settings });
  const valid = result.evidenceRecords.find((item) => item.providerId === "coverage-coverage-py-json" && item.source?.filePath === "valid.py");
  assert.equal(valid?.details?.total, 2);
  assert.equal(result.evidenceRecords.some((item) => item.providerId === "coverage-coverage-py-json" && item.source?.filePath === "invalid.py"), false);
  assert.ok(result.skipped.some((item) => item.filePath === "invalid.py" && /invalid executed_lines/.test(item.reason)));
  assert.equal(result.completeness?.status, "partial");
  assert.equal(result.evidenceRecords.some((item) => item.providerId === "coverage-coverage-py-json" && /0\/0/.test(item.summary)), false);
});

test("coverage.py inconsistent summaries are skipped while valid entries remain evidence", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "valid.py"), "value = 1\n");
  writeFileSync(path.join(directory, "inconsistent.py"), "value = 2\n");
  writeFileSync(
    path.join(directory, "coverage.json"),
    JSON.stringify({
      files: {
        "valid.py": {
          executed_lines: [1],
          missing_lines: [],
          summary: { num_statements: 1, covered_lines: 1, percent_covered: 100 },
        },
        "inconsistent.py": {
          executed_lines: [1],
          missing_lines: [2],
          summary: { num_statements: 1, covered_lines: 1, percent_covered: 100 },
        },
      },
    }),
  );
  const settings = config();
  settings.providers.coverageReports = [{ kind: "coverage-py-json", path: "coverage.json" }];
  const result = await scanFiles(directory, ["valid.py", "inconsistent.py"], undefined, "explicit", { config: settings });
  assert.ok(result.evidenceRecords.some((item) => item.providerId === "coverage-coverage-py-json" && item.source?.filePath === "valid.py"));
  assert.equal(result.evidenceRecords.some((item) => item.providerId === "coverage-coverage-py-json" && item.source?.filePath === "inconsistent.py"), false);
  assert.ok(result.skipped.some((item) => item.filePath === "inconsistent.py" && /summary is inconsistent/.test(item.reason)));
  assert.equal(result.completeness?.status, "partial");
  assert.equal(result.evidenceRecords.some((item) => item.providerId === "coverage-coverage-py-json" && item.source?.filePath === "inconsistent.py" && /100\.0%/.test(item.summary)), false);
});

test("dependency provenance remains local and network-off by default", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "input.ts"), "import value from 'surely-missing-package';\nvoid value;\n");
  let fetched = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("network should not run");
  }) as typeof fetch;
  try {
    const result = await scanFiles(directory, ["input.ts"]);
    const evidence = result.evidenceRecords.find((item) => item.providerId === "dependency-provenance");
    assert.equal(fetched, false);
    assert.match(evidence?.summary ?? "", /network provenance lookup disabled/);
    assert.equal(evidence?.details?.network, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dependency provenance exposes malformed manifest degradation instead of treating it as clean evidence", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "package.json"), "{broken");
  writeFileSync(path.join(directory, "input.ts"), "import value from 'surely-missing-package';\nvoid value;\n");
  const result = await scanFiles(directory, ["input.ts"]);
  const evidence = result.evidenceRecords.find((item) => item.providerId === "dependency-provenance");
  assert.ok(Array.isArray(evidence?.details?.manifestDiagnostics));
  assert.ok(result.skipped.some((item) => item.providerId === "dependency-provenance" && /package\.json/.test(item.reason)));
  assert.ok(result.scannedFiles.includes("input.ts"));
});

test("independent language servers run with bounded concurrency two", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "input.ts"), "export const value = 1;\n");
  writeFileSync(path.join(directory, "input.py"), "value = 1\n");
  const server = minimalLspServer(directory);
  const typescriptMarker = path.join(directory, "typescript-started");
  const pythonMarker = path.join(directory, "python-started");
  const settings = config();
  settings.limits.commandTimeoutMs = 2_000;
  settings.execution.trusted = true;
  settings.execution.lspServers.typescript = [process.execPath, server, typescriptMarker, pythonMarker];
  settings.execution.lspServers.python = [process.execPath, server, pythonMarker, typescriptMarker];

  const results = await collectLspEvidence(directory, ["input.ts", "input.py"], settings, true);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => !result.skipped.length));
});

test("language-server collection cancels while a provider is active", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "input.ts"), "export const value = 1;\n");
  const server = minimalLspServer(directory);
  const settings = config();
  settings.limits.commandTimeoutMs = 2_000;
  settings.execution.trusted = true;
  const marker = path.join(directory, "active");
  settings.execution.lspServers.typescript = [process.execPath, server, marker];
  const controller = new AbortController();
  const watcher = watch(directory);
  const active = once(watcher, "change");
  const pending = collectLspEvidence(directory, ["input.ts"], settings, true, controller.signal);
  await active;
  controller.abort();
  watcher.close();

  const results = await pending;
  assert.ok(results[0]?.skipped.some((item) => /cancel/i.test(item.reason)));
});

test("configured LSP execution is blocked until both trust gates pass", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "input.ts"), "const value = 1;\n");
  const marker = path.join(directory, "started");
  const server = path.join(directory, "server.js");
  writeFileSync(server, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`);
  const settings = config();
  settings.execution.trusted = true;
  settings.execution.lspServers.typescript = [process.execPath, server];
  const result = await scanFiles(directory, ["input.ts"], undefined, "explicit", { config: settings, trustedProject: false });
  assert.ok(result.skipped.some((item) => /requires both trusted/.test(item.reason)));
  assert.equal((await import("node:fs")).existsSync(marker), false);
});

test("malformed or oversized LSP framing fails closed without blocking native review", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "input.ts"), "const value = 1;\n");
  const server = path.join(directory, "malformed.cjs");
  writeFileSync(server, "process.stdin.once('data',()=>{process.stdout.write('Content-Length: 99999999\\r\\n\\r\\n');setTimeout(()=>process.exit(0),20);});\n");
  const settings = config();
  settings.execution.trusted = true;
  settings.execution.lspServers.typescript = [process.execPath, server];
  settings.limits.commandTimeoutMs = 2_000;
  const result = await scanFiles(directory, ["input.ts"], undefined, "explicit", { config: settings, trustedProject: true });
  assert.ok(result.skipped.some((item) => item.providerId === "lsp-typescript"));
  assert.ok(result.scannedFiles.includes("input.ts"));
});

test("trusted LSP contributes diagnostics, symbols, references, definitions, and call context with a scrubbed environment", async () => {
  const directory = root();
  writeFileSync(path.join(directory, "input.ts"), "const value = 1;\n");
  const server = path.join(directory, "server.cjs");
  writeFileSync(
    server,
    String.raw`
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}
function dispatch(message) {
  if (message.method === 'initialize') return send({jsonrpc:'2.0',id:message.id,result:{serverInfo:{name:'fake',version:'1.0'},capabilities:{}}});
  if (message.method === 'textDocument/diagnostic') return send({jsonrpc:'2.0',id:message.id,result:{items:[{range:{start:{line:0,character:0},end:{line:0,character:5}},severity:1,code:'FAKE',source:'fake',message:'secret=' + (process.env.AI_SLOP_SECRET || 'absent')}]}});
  if (message.method === 'textDocument/documentSymbol') return send({jsonrpc:'2.0',id:message.id,result:[{name:'value',kind:13,range:{start:{line:0,character:0},end:{line:0,character:15}},selectionRange:{start:{line:0,character:6},end:{line:0,character:11}}}]});
  if (message.method === 'textDocument/references') return send({jsonrpc:'2.0',id:message.id,result:[{}]});
  if (message.method === 'textDocument/definition') return send({jsonrpc:'2.0',id:message.id,result:[{}]});
  if (message.method === 'textDocument/prepareCallHierarchy') return send({jsonrpc:'2.0',id:message.id,result:[]});
  if (message.method === 'shutdown') return send({jsonrpc:'2.0',id:message.id,result:null});
  if (message.method === 'exit') process.exit(0);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(buffer.subarray(0, end).toString().match(/Content-Length:\s*(\d+)/i)[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString();
    buffer = buffer.subarray(end + 4 + length);
    dispatch(JSON.parse(body));
  }
});
`,
  );
  const settings = config();
  settings.execution.trusted = true;
  const injectedMarker = path.join(directory, "injected");
  settings.execution.lspServers.typescript = [process.execPath, server, `;touch ${injectedMarker}`];
  process.env.AI_SLOP_SECRET = "must-not-leak";
  try {
    const result = await scanFiles(directory, ["input.ts"], undefined, "explicit", {
      config: settings,
      trustedProject: true,
    });
    const finding = result.findings.find((item) => item.ruleId === "lsp.typescript.fake.FAKE");
    assert.equal(finding?.message, "secret=absent");
    const symbolEvidence = result.evidenceRecords.find((item) => item.summary.includes("document symbol"));
    const contextEvidence = result.evidenceRecords.find((item) => item.summary.includes("context for symbol"));
    assert.equal(symbolEvidence?.details?.symbols instanceof Array, true);
    assert.equal(contextEvidence?.details?.references, 1);
    assert.equal(contextEvidence?.details?.definitions, 1);
    assert.equal(contextEvidence?.details?.callHierarchy, 0);
    assert.equal(existsSync(injectedMarker), false);
  } finally {
    delete process.env.AI_SLOP_SECRET;
  }
});

test("decodes file URLs and rejects non-finite analyzer coordinates", () => {
  const directory = root();
  const sourcePath = path.join(directory, "file with spaces.ts");
  writeFileSync(sourcePath, "const value = 1;\n");
  const file = safeProjectFile(directory, pathToFileURL(sourcePath).toString());
  assert.equal(file?.filePath, "file with spaces.ts");
  const reportPath = path.join(directory, "eslint.json");
  writeFileSync(reportPath, JSON.stringify([{
    filePath: sourcePath,
    messages: [
      { ruleId: "bad", severity: 2, message: "bad", line: "Infinity", column: 1 },
      { ruleId: "good", severity: 2, message: "good", line: 1, column: 1 },
    ],
  }]));
  const result = importAnalyzerReports(directory, [{ kind: "eslint", path: "eslint.json" }]);
  assert.equal(result.findings.length, 1);
  assert.ok(result.skipped.some((item) => /non-finite/.test(item.reason)));
});


test("malformed analyzer records do not become default-coordinate findings", () => {
  const directory = root();
  writeFileSync(path.join(directory, "input.ts"), "const value = 1;\n");
  writeFileSync(path.join(directory, "ruff.json"), JSON.stringify([
    { filename: path.join(directory, "input.ts"), location: { row: "1", column: 1 }, code: "bad", message: "bad" },
    { filename: path.join(directory, "input.ts"), location: { row: 1, column: 1 }, code: "good", message: "good" },
  ]));
  const result = importAnalyzerReports(directory, [{ kind: "ruff", path: "ruff.json" }]);
  assert.equal(result.findings.length, 1);
  assert.ok(result.skipped.some((item) => /non-finite or non-integral/.test(item.reason)));
});