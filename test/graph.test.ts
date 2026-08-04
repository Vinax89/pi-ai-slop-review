import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as ts from "typescript";

import { DEFAULT_CONFIG, type AiSlopConfig } from "../src/core/config.ts";
import { buildGraphFacts } from "../src/graph/build.ts";
import { collectGraphEvidence } from "../src/graph/provider.ts";
import { GraphStore } from "../src/graph/store.ts";
import { scanFiles } from "../src/scan.ts";
import { scanTypeScriptFilesWithProjects } from "../src/typescript-scanner.ts";

function fixture(): { root: string; state: string; config: AiSlopConfig } {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-graph-"));
  const state = mkdtempSync(path.join(tmpdir(), "ai-slop-graph-state-"));
  const config = structuredClone(DEFAULT_CONFIG);
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "tests"));
  mkdirSync(path.join(root, "client"));
  mkdirSync(path.join(root, "server"));
  mkdirSync(path.join(root, "docs"));
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["**/*.ts"] }),
  );
  config.graph.layers = [
    { name: "client", patterns: ["client/**"] },
    { name: "server", patterns: ["server/**"] },
  ];
  config.graph.allowedEdges = [];
  return { root, state, config };
}

test("repository graph links symbols, calls, tests, specifications, public surfaces, clones, frameworks, and architecture", async () => {
  const { root, state, config } = fixture();
  writeFileSync(path.join(root, "src/service.ts"), "export function load(value: number) { return value + 1; }\n");
  writeFileSync(path.join(root, "src/clone.ts"), "function increment(value: number) { return value + 1; }\nvoid increment(1);\n");
  writeFileSync(path.join(root, "tests/service.test.ts"), "import { load } from '../src/service.js';\nexport function testLoad() { return load(1); }\n");
  writeFileSync(path.join(root, "server/api.ts"), "export function api() { return 1; }\n");
  writeFileSync(path.join(root, "client/use-api.ts"), "import { api } from '../server/api.js';\nexport const GET = () => api();\n");
  writeFileSync(path.join(root, "docs/spec.md"), "# REQ-1 Service behavior\nGoverned by [`service`](../src/service.ts).\n");
  const paths = ["src/service.ts", "src/clone.ts", "tests/service.test.ts", "server/api.ts", "client/use-api.ts", "docs/spec.md"];
  const result = await collectGraphEvidence(root, paths, config, undefined, state);

  assert.equal(result.findings.filter((item) => item.ruleId === "structure.duplicate-capability").length, 1);
  assert.ok(result.findings.some((item) => item.ruleId === "architecture.disallowed-dependency"));
  const loadGap = result.findings.find((item) => item.ruleId === "assurance.no-linked-tests" && item.message.includes("load"));
  assert.equal(loadGap, undefined);
  assert.ok(result.evidenceRecords.some((item) => item.summary.includes("framework or runtime registration")));
  assert.ok(result.evidenceRecords.some((item) => item.summary.startsWith("public surface:")));
  const impact = result.evidenceRecords.find((item) => item.summary.includes("exported 'load'"));
  assert.equal((impact?.details?.tests as unknown[])?.length, 1);
  assert.equal((impact?.details?.governingSpecifications as unknown[])?.length, 1);

  const store = new GraphStore(root, state);
  const stats = store.statistics();
  assert.equal(stats.files, paths.length);
  const load = store.findByName("load")[0];
  assert.ok(load);
  assert.ok(store.impact(load.id).incoming.some((edge) => edge.kind === "calls"));
  store.close();

  const second = await collectGraphEvidence(root, paths, config, undefined, state);
  assert.ok(second.findings.some((item) => item.ruleId === "structure.duplicate-capability"));
  const surface = second.evidenceRecords.find((item) => item.summary.startsWith("public surface:"));
  assert.match(surface?.summary ?? "", /0 added, 0 changed, 0 removed/);
});

test("graph batches parse each TypeScript project once and persist in one transaction", async () => {
  const { root, state, config } = fixture();
  const paths = Array.from({ length: 25 }, (_, index) => `src/value-${index}.ts`);
  for (const [index, filePath] of paths.entries()) {
    writeFileSync(path.join(root, filePath), `export const value${index} = ${index};\n`);
  }
  let configReads = 0;
  let configChecks = 0;
  const readFile = ts.sys.readFile;
  const fileExists = ts.sys.fileExists;
  ts.sys.readFile = (fileName, encoding) => {
    if (path.basename(fileName) === "tsconfig.json") configReads += 1;
    return readFile(fileName, encoding);
  };
  ts.sys.fileExists = (fileName) => {
    if (/^(?:tsconfig|jsconfig)\.json$/.test(path.basename(fileName))) configChecks += 1;
    return fileExists(fileName);
  };
  let built;
  try {
    built = await buildGraphFacts(root, paths, config);
  } finally {
    ts.sys.readFile = readFile;
    ts.sys.fileExists = fileExists;
  }
  assert.equal(configReads, 1);
  assert.equal(configChecks, 2);
  assert.equal(built.facts.length, paths.length);
  const store = new GraphStore(root, state);
  assert.equal(store.updateFiles(built.facts), paths.length);
  assert.equal(store.updateFiles(built.facts), 0);
  assert.equal(store.statistics().files, paths.length);
  const nodePages = [...store.nodePages(7)];
  assert.ok(nodePages.length > 1);
  assert.equal(nodePages.flat().length, store.statistics().nodes);
  const selectedPages = [...store.nodePagesForFiles(paths.slice(0, 2), 2)];
  assert.ok(selectedPages.every((page) => page.length <= 2));
  assert.deepEqual(new Set(selectedPages.flat().map((node) => node.filePath)), new Set(paths.slice(0, 2)));
  const edgePages = [...store.edgePages(paths[0], 1)];
  assert.ok(edgePages.length > 1);
  assert.equal(edgePages.flat().length, store.edges(paths[0]).length);
  store.close();
});

test("graph builder streams fact batches without retaining the aggregate", async () => {
  const { root, state, config } = fixture();
  const paths = Array.from({ length: 3 }, (_, index) => `src/stream-${index}.ts`);
  for (const [index, filePath] of paths.entries()) {
    writeFileSync(path.join(root, filePath), `export const stream${index} = ${index};\n`);
  }
  const store = new GraphStore(root, state);
  const streamed: string[] = [];
  const built = await buildGraphFacts(root, paths, config, undefined, [], new Map(), (facts) => {
    streamed.push(...facts.map((item) => item.filePath));
    store.updateFiles(facts);
  });
  assert.deepEqual(built.facts, []);
  assert.deepEqual(streamed.sort(), paths);
  assert.equal(store.statistics().files, paths.length);
  store.close();
});

test("graph reuses the native TypeScript project without rediscovering configuration", async () => {
  const { root, config } = fixture();
  const paths = ["src/first.ts", "src/second.ts"];
  writeFileSync(path.join(root, paths[0]), "export const first = 1;\n");
  writeFileSync(path.join(root, paths[1]), "export const second = 2;\n");
  const native = scanTypeScriptFilesWithProjects(root, paths);
  let configReads = 0;
  const readFile = ts.sys.readFile;
  ts.sys.readFile = (fileName, encoding) => {
    if (path.basename(fileName) === "tsconfig.json") configReads += 1;
    return readFile(fileName, encoding);
  };
  let built;
  try {
    built = await buildGraphFacts(root, paths, config, undefined, native.projects);
  } finally {
    ts.sys.readFile = readFile;
  }
  assert.equal(configReads, 0);
  assert.equal(built.facts.length, paths.length);
});

test("large TypeScript audits stay bounded and report the omitted graph", async () => {
  const { root, state, config } = fixture();
  const paths = Array.from({ length: 251 }, (_, index) => `src/value-${index}.ts`);
  for (const [index, filePath] of paths.entries()) {
    writeFileSync(
      path.join(root, filePath),
      index === 0
        ? "function load(value: number) { return value; }\nexport function wrapper(value: number) { return load(value); }\n"
        : `export const value${index} = ${index};\n`,
    );
  }

  const result = await scanFiles(root, paths, undefined, "repository", {
    config,
    graphStateRoot: state,
    policyStateRoot: mkdtempSync(path.join(tmpdir(), "ai-slop-policy-state-")),
  });

  assert.equal(result.scannedFiles.length, paths.length);
  assert.equal(result.completeness?.status, "partial");
  assert.match(result.providers.find((provider) => provider.id === "repository-graph")?.diagnostic ?? "", /memory budget/);
  const wrapper = result.findings.find((finding) => finding.ruleId === "structure.pass-through-wrapper");
  assert.equal(wrapper?.maximumAction, "observe");
  assert.match(wrapper?.unknown.join(" ") ?? "", /memory-bounded/);
});

test("repository graph summarizes duplicate groups once with bounded examples", async () => {
  const { root, state, config } = fixture();
  const paths = Array.from({ length: 8 }, (_, index) => `src/clone-${index}.ts`);
  for (const [index, filePath] of paths.entries()) {
    writeFileSync(path.join(root, filePath), `export function clone${index}(value: number) { return value + 1; }\n`);
  }
  const result = await collectGraphEvidence(root, paths, config, undefined, state, "repository");
  const duplicates = result.findings.filter((item) => item.ruleId === "structure.duplicate-capability");
  assert.equal(duplicates.length, 1);
  assert.match(duplicates[0].message, /7 other location\(s\)/);
  assert.match(duplicates[0].message, /\(\+2 more\)/);
  assert.ok(duplicates[0].message.length < 600);
});

test("Python graph remains isolated while capturing exports, calls, tests, imports, and framework decorators", async () => {
  const { root, state, config } = fixture();
  writeFileSync(
    path.join(root, "service.py"),
    "from fastapi import FastAPI\napp = FastAPI()\n\ndef helper(value):\n    return value + 1\n\n@app.get('/value')\ndef get_value():\n    return helper(1)\n\ndef test_value():\n    return get_value()\n",
  );
  const result = await collectGraphEvidence(root, ["service.py"], config, undefined, state);
  assert.equal(result.skipped.length, 0);
  assert.ok(result.evidenceRecords.some((item) => item.summary.includes("framework or runtime registration")));
  const store = new GraphStore(root, state);
  assert.ok(store.findByName("helper").length);
  assert.ok(store.edges("service.py").some((edge) => edge.kind === "imports"));
  assert.ok(store.edges("service.py").some((edge) => edge.kind === "covers"));
  store.close();
});

test("graph captures npm and Python package entry points without executing manifests", async () => {
  const { root, state, config } = fixture();
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ main: "dist/index.js", exports: { ".": "./dist/index.js" }, bin: { tool: "bin/tool.js" }, dependencies: { typescript: "^5" } }),
  );
  writeFileSync(
    path.join(root, "pyproject.toml"),
    "[project]\nname = \"fixture\"\n[project.scripts]\nfixture = \"fixture.cli:main\"\n[project.entry-points.\"fixture.plugins\"]\nplugin = \"fixture.plugin:Plugin\"\n",
  );
  const result = await collectGraphEvidence(root, ["package.json", "pyproject.toml"], config, undefined, state);
  assert.equal(result.skipped.length, 0);
  const store = new GraphStore(root, state);
  const registrations = store.nodes().filter((node) => node.kind === "registration");
  assert.ok(registrations.some((node) => node.metadata.framework === "package-entry"));
  assert.ok(registrations.some((node) => node.metadata.framework === "python-entry-point"));
  assert.ok(store.edges("package.json").some((edge) => edge.kind === "depends-on"));
  store.close();
});

test("graph reports malformed manifests and removes their stale facts", async () => {
  const { root, state, config } = fixture();
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", exports: "./index.js" }));
  await collectGraphEvidence(root, ["package.json"], config, undefined, state);
  writeFileSync(path.join(root, "package.json"), "{broken");
  const result = await collectGraphEvidence(root, ["package.json"], config, undefined, state);
  assert.ok(result.skipped.some((item) => item.filePath === "package.json" && /cannot parse package manifest/.test(item.reason)));
  assert.equal(result.scannedFiles.includes("package.json"), false);
  assert.match(result.evidenceRecords.find((item) => item.summary.startsWith("public surface:"))?.summary ?? "", /1 removed/);
  const store = new GraphStore(root, state);
  assert.equal(store.files().includes("package.json"), false);
  store.close();
});

test("graph preserves last-known facts when the Python helper is transiently unavailable", async () => {
  const { root, state, config } = fixture();
  writeFileSync(path.join(root, "service.py"), "def available():\n    return 1\n");
  await collectGraphEvidence(root, ["service.py"], config, undefined, state);
  const previousPython = process.env.PI_AI_SLOP_PYTHON;
  process.env.PI_AI_SLOP_PYTHON = path.join(root, "missing-python");
  let result;
  try {
    result = await collectGraphEvidence(root, ["service.py"], config, undefined, state);
  } finally {
    if (previousPython === undefined) delete process.env.PI_AI_SLOP_PYTHON;
    else process.env.PI_AI_SLOP_PYTHON = previousPython;
  }
  assert.ok(result.skipped.some((item) => item.filePath === "service.py" && /Python graph scan unavailable/.test(item.reason)));
  assert.match(result.evidenceRecords.find((item) => item.summary.startsWith("public surface:"))?.summary ?? "", /0 added, 0 changed, 0 removed/);
  const store = new GraphStore(root, state);
  assert.equal(store.files().includes("service.py"), true);
  assert.ok(store.findByName("available").length);
  store.close();
});

test("graph prunes deleted files and incoming stale edges during partial reviews", async () => {
  const { root, state, config } = fixture();
  writeFileSync(path.join(root, "src/removed.ts"), "export function removed() { return 1; }\n");
  writeFileSync(path.join(root, "src/caller.ts"), "import { removed } from './removed.js';\nexport function caller() { return removed(); }\n");
  writeFileSync(path.join(root, "src/remaining.ts"), "export function remaining() { return 2; }\n");
  await collectGraphEvidence(root, ["src/removed.ts", "src/caller.ts"], config, undefined, state);
  const before = new GraphStore(root, state);
  const removedId = before.findByName("removed")[0]?.id;
  assert.ok(removedId);
  before.close();
  unlinkSync(path.join(root, "src/removed.ts"));
  const result = await collectGraphEvidence(root, ["src/remaining.ts"], config, undefined, state);
  assert.match(result.evidenceRecords.find((item) => item.summary.startsWith("public surface:"))?.summary ?? "", /1 removed/);
  const after = new GraphStore(root, state);
  assert.equal(after.findByName("removed").length, 0);
  assert.equal(after.files().includes("src/caller.ts"), true);
  assert.equal(after.edges().some((edge) => edge.toId === removedId), false);
  after.close();
});

test("graph public surface detects signature changes incrementally", async () => {
  const { root, state, config } = fixture();
  const file = path.join(root, "src/service.ts");
  writeFileSync(file, "export function load(value: number) { return value; }\n");
  await collectGraphEvidence(root, ["src/service.ts"], config, undefined, state);
  writeFileSync(file, "export function load(value: string) { return value; }\n");
  const result = await collectGraphEvidence(root, ["src/service.ts"], config, undefined, state);
  const surface = result.evidenceRecords.find((item) => item.summary.startsWith("public surface:"));
  assert.match(surface?.summary ?? "", /1 changed/);
});

test("graph resolves Python cross-file imports, keeps helpers non-test, and strips markdown URL suffixes", async () => {
  const { root, config } = fixture();
  mkdirSync(path.join(root, "pkg"));
  writeFileSync(path.join(root, "pkg", "base.py"), "value = 1\n");
  writeFileSync(path.join(root, "pkg", "consumer.py"), "from .base import value\n\ndef helper():\n    return value\n");
  writeFileSync(path.join(root, "tests", "test_consumer.py"), "def test_value():\n    return 1\n\ndef helper():\n    return 2\n");
  writeFileSync(path.join(root, "docs", "links.md"), "# REQ-2 Link\nGoverned by [base](../pkg/base.py?raw=1#L1).\n");
  const built = await buildGraphFacts(root, ["pkg/base.py", "pkg/consumer.py", "tests/test_consumer.py", "docs/links.md"], config);
  const importEdge = built.facts.find((item) => item.filePath === "pkg/consumer.py")?.edges.find((item) => item.kind === "imports");
  assert.equal(importEdge?.metadata?.resolved, "pkg/base.py");
  const testFacts = built.facts.find((item) => item.filePath === "tests/test_consumer.py");
  assert.equal(testFacts?.nodes.find((item) => item.name === "helper")?.kind, "function");
  assert.equal(testFacts?.nodes.find((item) => item.name === "test_value")?.kind, "test");
  const specification = built.facts.find((item) => item.filePath === "docs/links.md");
  assert.ok(specification?.edges.some((item) => item.kind === "governs" && item.metadata.targetPath === "pkg/base.py"));
});

test("graph isolates malformed TOML facts and invalidates TypeScript facts when tsconfig changes", async () => {
  const { root, config } = fixture();
  writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname = \"fixture\"\n");
  writeFileSync(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  const first = await buildGraphFacts(root, ["pyproject.toml", "src/value.ts"], config);
  writeFileSync(path.join(root, "pyproject.toml"), "[broken");
  const malformed = await buildGraphFacts(root, ["pyproject.toml", "src/value.ts"], config);
  assert.equal(malformed.facts.some((item) => item.filePath === "pyproject.toml"), false);
  assert.equal(typeof malformed.errors["pyproject.toml"], "string");
  const before = first.facts.find((item) => item.filePath === "src/value.ts");
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, allowJs: true } }));
  const changed = await buildGraphFacts(root, ["src/value.ts"], config);
  const after = changed.facts[0];
  assert.equal(before?.sourceHash, after.sourceHash);
  assert.notEqual(before?.cacheHash, after.cacheHash);
});


test("graph removes facts when an existing source becomes an outside symlink", async () => {
  const { root, state, config } = fixture();
  const source = path.join(root, "src", "service.ts");
  writeFileSync(source, "export function service() { return 1; }\n");
  await collectGraphEvidence(root, ["src/service.ts"], config, undefined, state);
  const outside = path.join(tmpdir(), `ai-slop-outside-${Date.now()}.ts`);
  writeFileSync(outside, "export function escaped() { return 2; }\n");
  unlinkSync(source);
  symlinkSync(outside, source);
  try {
    const result = await collectGraphEvidence(root, ["src/service.ts"], config, undefined, state);
    assert.ok(result.skipped.some((item) => item.filePath === "src/service.ts" && /outside/.test(item.reason)));
    const store = new GraphStore(root, state);
    assert.equal(store.files().includes("src/service.ts"), false);
    store.close();
  } finally {
    unlinkSync(source);
    unlinkSync(outside);
  }
});

test("graph ignores headings and links inside fenced Markdown blocks", async () => {
  const { root, config } = fixture();
  writeFileSync(path.join(root, "src", "service.ts"), "export function service() { return 1; }\n");
  writeFileSync(
    path.join(root, "docs", "spec.md"),
    "# REQ-1 Real\nGoverned by [`service`](../src/service.ts).\n\n```md\n# REQ-2 Fake\nGoverned by [`service`](../src/service.ts).\n```\n",
  );
  const built = await buildGraphFacts(root, ["docs/spec.md"], config);
  const specification = built.facts[0];
  assert.equal(specification?.nodes.filter((node) => node.kind === "requirement").length, 1);
  assert.equal(specification?.edges.filter((edge) => edge.kind === "governs").length, 1);
});