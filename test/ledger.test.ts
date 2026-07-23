import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { AssuranceLedger, diffScans } from "../src/core/ledger.ts";
import { createScanResult } from "../src/core/schema.ts";
import type { AiSlopConfig } from "../src/core/config.ts";
import type { FindingDraft } from "../src/types.ts";

function config(): AiSlopConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    verification: {
      commands: [
        { pattern: "npm test", kind: "unit-test", authoritativeFor: ["**/*.ts"] },
        { pattern: "npm run typecheck", kind: "typecheck", authoritativeFor: ["**/*.ts"] },
      ],
    },
  };
}

function mutate(ledger: AssuranceLedger, root: string, toolCallId: string, content: string): void {
  ledger.captureToolCall({ toolCallId, toolName: "write", input: { path: "src/input.ts", content } });
  writeFileSync(path.join(root, "src/input.ts"), content);
  const event = ledger.captureToolResult({ toolCallId, toolName: "write", input: {}, isError: false });
  assert.equal(event?.kind, "mutation");
}

test("assurance ledger tracks exact hashes, configured checks, and claims", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-ledger-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/input.ts"), "export const value = 1;\n");
  const ledger = new AssuranceLedger(root, config());
  mutate(ledger, root, "write-1", "export const value = 2;\n");

  ledger.captureToolCall({ toolCallId: "test-1", toolName: "ctx_shell", input: { command: "npm test" } });
  const verification = ledger.captureToolResult({ toolCallId: "test-1", toolName: "ctx_shell", input: {}, isError: false });
  assert.equal(verification?.kind, "verification");
  assert.equal(ledger.verificationStatus()[0].fresh.length, 1);
  assert.equal(ledger.assessClaims("All tests passed.")[0].status, "supported");

  mutate(ledger, root, "write-2", "export const value = 3;\n");
  const status = ledger.verificationStatus()[0];
  assert.equal(status.fresh.length, 0);
  assert.equal(status.stale.length, 1);
  assert.equal(ledger.assessClaims("All tests passed.")[0].status, "unverifiable");

  const reconstructed = new AssuranceLedger(root, config());
  reconstructed.reconstruct(ledger.entries().slice(0, 2));
  assert.deepEqual(reconstructed.touchedPaths(), ["src/input.ts"]);
});

test("failed configured checks refute passed claims", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-ledger-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/input.ts"), "const value = 1;\n");
  const ledger = new AssuranceLedger(root, config());
  mutate(ledger, root, "write", "const value = 2;\n");
  ledger.captureToolCall({ toolCallId: "test", toolName: "bash", input: { command: "npm test" } });
  ledger.captureToolResult({ toolCallId: "test", toolName: "bash", input: {}, isError: true });
  assert.equal(ledger.assessClaims("Tests passed.")[0].status, "refuted");
  ledger.captureToolCall({ toolCallId: "test-again", toolName: "bash", input: { command: "npm test" } });
  ledger.captureToolResult({ toolCallId: "test-again", toolName: "bash", input: {}, isError: false });
  assert.equal(ledger.assessClaims("Tests passed.")[0].status, "supported");
});

test("ledger ignores mutation paths that escape through a symlink", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-ledger-"));
  const outside = mkdtempSync(path.join(tmpdir(), "ai-slop-outside-"));
  symlinkSync(outside, path.join(root, "linked"));
  const ledger = new AssuranceLedger(root, config());
  ledger.captureToolCall({ toolCallId: "escape", toolName: "write", input: { path: "linked/input.ts" } });
  writeFileSync(path.join(outside, "input.ts"), "unsafe\n");
  assert.equal(ledger.captureToolResult({ toolCallId: "escape", toolName: "write", isError: false }), undefined);
  assert.deepEqual(ledger.touchedPaths(), []);
});

test("scan delta uses stable finding identity instead of line number", () => {
  const finding = (line: number): FindingDraft => ({
    anchor: "function:wrapper",
    ruleId: "structure.pass-through-wrapper",
    classification: "waste_candidate",
    confidence: "C2",
    risk: "R2",
    maximumAction: "propose",
    filePath: "input.ts",
    line,
    column: 1,
    start: line * 10,
    end: line * 10 + 5,
    sourceHash: String(line),
    message: "wrapper",
    evidence: ["identity arguments"],
    counterEvidence: [],
    unknown: [],
  });
  const baseline = createScanResult({
    engine: "semantic-review",
    engineVersion: "1",
    rootDir: "/tmp/project",
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [finding(1)],
    skipped: [],
  });
  const current = createScanResult({
    engine: "semantic-review",
    engineVersion: "1",
    rootDir: "/tmp/project",
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [finding(20)],
    skipped: [],
  });
  const delta = diffScans(current, baseline);
  assert.equal(delta.added.length, 0);
  assert.equal(delta.unchanged.length, 1);
});
