import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, loadConfig } from "../src/core/config.ts";
import { discoverRepositoryFiles } from "../src/core/discovery.ts";
import { createScanResult, isScanResult } from "../src/core/schema.ts";
import { diagnose } from "../src/diagnostics.ts";
import { toSarif, writeExport } from "../src/export.ts";
import { importSarif } from "../src/providers/sarif.ts";
import type { FindingDraft } from "../src/types.ts";

function fixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-interface-"));
  writeFileSync(path.join(root, "input.ts"), "const value = 1;\n");
  return root;
}

function finding(): FindingDraft {
  return {
    anchor: "value",
    ruleId: "test.rule",
    classification: "context_conflict",
    confidence: "C2",
    risk: "R2",
    maximumAction: "observe",
    filePath: "input.ts",
    line: 1,
    column: 1,
    start: 0,
    end: 5,
    sourceHash: "hash",
    message: "Example finding",
    evidence: ["test evidence"],
    counterEvidence: [],
    unknown: [],
  };
}

test("repository discovery is explicit, bounded, and ignores symlinked or generated dependency trees", () => {
  const root = fixture();
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "node_modules"));
  writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "src/b.py"), "b = 1\n");
  writeFileSync(path.join(root, "node_modules/ignored.js"), "bad\n");
  const outside = mkdtempSync(path.join(tmpdir(), "ai-slop-interface-outside-"));
  writeFileSync(path.join(outside, "outside.ts"), "outside\n");
  symlinkSync(outside, path.join(root, "linked"));
  const discovered = discoverRepositoryFiles(root, 100);
  assert.deepEqual(discovered.paths, ["input.ts", "src/a.ts", "src/b.py"]);
  assert.equal(discovered.truncated, false);
  assert.equal(discoverRepositoryFiles(root, 1).truncated, true);
});

test("JSON and SARIF exports are schema-shaped, atomic, and SARIF-importable", () => {
  const root = fixture();
  const result = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [finding()],
    skipped: [],
  });
  const jsonPath = writeExport(root, result, "json", "reports/result.json");
  assert.equal(isScanResult(JSON.parse(readFileSync(jsonPath, "utf8"))), true);
  const sarif = toSarif(result) as any;
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0].results.length, 1);
  const sarifPath = writeExport(root, result, "sarif", "reports/result.sarif.json");
  const imported = importSarif(root, [path.relative(root, sarifPath)]);
  assert.equal(imported.findings.length, 1);
  assert.match(imported.findings[0].ruleId, /test\.rule/);
  assert.doesNotThrow(() => JSON.parse(readFileSync(new URL("../schema/scan-result.schema.json", import.meta.url), "utf8")));
  assert.doesNotThrow(() => JSON.parse(readFileSync(new URL("../schema/config.schema.json", import.meta.url), "utf8")));
});

test("exports reject symlink escapes and default to private extension state", () => {
  const root = fixture();
  const outside = mkdtempSync(path.join(tmpdir(), "ai-slop-export-outside-"));
  symlinkSync(outside, path.join(root, "linked"));
  const result = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: [],
    findings: [],
    skipped: [],
  });
  assert.throws(() => writeExport(root, result, "json", "linked/result.json"), /outside/);
  const state = mkdtempSync(path.join(tmpdir(), "ai-slop-export-state-"));
  const output = writeExport(root, result, "json", undefined, state);
  assert.equal(existsSync(output), true);
  assert.equal(path.relative(root, output).startsWith(".."), true);
});

test("diagnostics report safe defaults and runtime/store health without enabling network", () => {
  const root = fixture();
  const loaded = loadConfig(root, { globalPath: path.join(root, "missing.json") });
  assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  const report = diagnose(root, loaded);
  assert.equal(report.networkEnabled, false);
  assert.equal(report.executionTrusted, false);
  assert.ok(report.checks.some((check) => check.name === "rules" && check.ok));
  assert.ok(report.checks.some((check) => check.name === "state" && check.ok));
});
