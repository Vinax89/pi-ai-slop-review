import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, type AiSlopConfig } from "../src/core/config.ts";
import { collectGraphEvidence } from "../src/graph/provider.ts";
import { GraphStore } from "../src/graph/store.ts";

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

  assert.ok(result.findings.some((item) => item.ruleId === "structure.duplicate-capability"));
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

test("graph reports malformed manifests instead of silently omitting them", async () => {
  const { root, state, config } = fixture();
  writeFileSync(path.join(root, "package.json"), "{broken");
  const result = await collectGraphEvidence(root, ["package.json"], config, undefined, state);
  assert.ok(result.skipped.some((item) => item.filePath === "package.json" && /cannot parse package manifest/.test(item.reason)));
  assert.equal(result.scannedFiles.includes("package.json"), false);
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
