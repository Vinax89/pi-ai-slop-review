import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, type AiSlopConfig } from "../src/core/config.ts";
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
