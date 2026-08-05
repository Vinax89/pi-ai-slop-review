import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, loadConfig, redactConfig } from "../src/core/config.ts";
import { diffScans } from "../src/core/ledger.ts";
import { discoverRepositoryFiles } from "../src/core/discovery.ts";
import { createScanResult, isScanResult, sha256 } from "../src/core/schema.ts";
import { StateStore } from "../src/core/store.ts";
import { diagnose, redactSensitive } from "../src/diagnostics.ts";
import { toMarkdown, toSarif, writeExport } from "../src/export.ts";
import { importSarif } from "../src/providers/sarif.ts";
import { createFindingQueue, formatDelta, formatReport, formatTriage } from "../src/report.ts";
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

test("repository audits default to a 10,000-file ceiling", () => {
  assert.equal(DEFAULT_CONFIG.limits.maxFiles, 10_000);
});

test("repository discovery is explicit, bounded, and ignores symlinked or generated dependency trees", () => {
  const root = fixture();
  mkdirSync(path.join(root, "src"));
  mkdirSync(path.join(root, "node_modules"));
  mkdirSync(path.join(root, ".next"));
  mkdirSync(path.join(root, ".claude/worktrees/branch"), { recursive: true });
  writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(path.join(root, "src/b.py"), "b = 1\n");
  writeFileSync(path.join(root, "node_modules/ignored.js"), "bad\n");
  writeFileSync(path.join(root, ".next/ignored.js"), "generated\n");
  writeFileSync(path.join(root, ".claude/worktrees/branch/ignored.ts"), "generated\n");
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
  assert.equal(sarif.runs[0].tool.driver.semanticVersion, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.equal(sarif.runs[0].results.length, 1);
  const sarifPath = writeExport(root, result, "sarif", "reports/result.sarif.json");
  const markdownPath = writeExport(root, result, "markdown", "reports/findings.md");
  assert.match(readFileSync(markdownPath, "utf8"), /# AI-Slop Review — Human Decision Report/);
  const imported = importSarif(root, [path.relative(root, sarifPath)]);
  assert.equal(imported.findings.length, 1);
  assert.match(imported.findings[0].ruleId, /test\.rule/);
  assert.doesNotThrow(() => JSON.parse(readFileSync(new URL("../schema/scan-result.schema.json", import.meta.url), "utf8")));
  assert.doesNotThrow(() => JSON.parse(readFileSync(new URL("../schema/config.schema.json", import.meta.url), "utf8")));
});

test("failed export serialization removes the process temp file for retry", () => {
  const root = fixture();
  const result = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [],
    skipped: [],
  });
  const requestedPath = "reports/retry.json";
  const temporaryPath = path.join(root, `${requestedPath}.${process.pid}.tmp`);
  const malformed = { ...result, generatedAt: 1n as unknown as string };

  assert.throws(() => writeExport(root, malformed, "json", requestedPath));
  assert.equal(existsSync(temporaryPath), false);
  assert.equal(writeExport(root, result, "json", requestedPath), path.join(root, requestedPath));
});

test("agent finding queues expose stable IDs, bounded pages, and rule representatives", () => {
  const root = fixture();
  const result = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [
      finding(),
      { ...finding(), anchor: "second", line: 2, ruleId: "other.rule" },
      { ...finding(), anchor: "third", line: 3 },
    ],
    skipped: [],
  });
  const representatives = createFindingQueue(result, { representatives: true });
  assert.equal(representatives.totalFindings, 3);
  assert.equal(representatives.queueSize, 2);
  assert.deepEqual(new Set(representatives.findings.map((item) => item.finding.ruleId)), new Set(["test.rule", "other.rule"]));
  for (const item of representatives.findings) assert.match(representatives.text, new RegExp(item.finding.id));

  const page = createFindingQueue(result, { limit: 1 });
  assert.equal(page.findings.length, 1);
  assert.match(page.text, /Next offset: 1/);
});


test("scan completeness distinguishes complete, partial, and abstained outcomes", () => {
  const root = fixture();
  const complete = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [],
    skipped: [],
  });
  assert.equal(complete.completeness?.status, "complete");
  const expectedExclusions = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [],
    skipped: [{ filePath: "generated.py", reason: "generated or vendor-like file" }],
  });
  assert.equal(expectedExclusions.completeness?.status, "complete");
  assert.equal(expectedExclusions.completeness?.skippedItems, 0);
  const partial = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    providers: [{ id: "test", version: "1", capabilities: [], status: "failed", diagnostic: "fixture failure" }],
    scannedFiles: ["input.ts"],
    findings: [],
    skipped: [],
  });
  assert.equal(partial.completeness?.status, "partial");
  assert.match(toMarkdown(partial), /must not be interpreted as a clean scan/);
  assert.equal((toSarif(partial) as any).runs[0].invocations[0].executionSuccessful, false);
  const abstained = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: [],
    findings: [],
    skipped: [{ filePath: "unsupported.rb", reason: "unsupported extension" }],
  });
  assert.equal(abstained.completeness?.status, "abstained");
  const disabled = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "repository-graph",
    providerVersion: "1",
    providers: [{ id: "repository-graph", version: "1", capabilities: [], status: "skipped", diagnostic: "disabled by configuration" }],
    scannedFiles: ["input.ts"],
    findings: [],
    skipped: [{ filePath: "<graph>", reason: "repository graph is disabled by configuration" }],
  });
  assert.equal(disabled.completeness?.status, "partial");
});

test("truncated repository audits persist and export partial completeness", () => {
  const root = fixture();
  const truncated = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [],
    skipped: [{ filePath: "<repository-discovery>", reason: "repository discovery stopped at configured file limit", providerId: "repository-discovery" }],
  });
  assert.equal(truncated.completeness?.status, "partial");
  assert.match(truncated.completeness?.reasons.join(" ") ?? "", /skipped or omitted/);
  const stateRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-interface-state-"));
  new StateStore(root, stateRoot).update((state) => {
    state.baselines["last-audit"] = truncated;
  });
  assert.equal(new StateStore(root, stateRoot).load().baselines["last-audit"].completeness?.status, "partial");
  assert.equal(JSON.stringify(toSarif(truncated)).includes('"executionSuccessful":false'), true);
  const jsonPath = writeExport(root, truncated, "json", "reports/truncated.json");
  assert.equal(JSON.parse(readFileSync(jsonPath, "utf8")).completeness.status, "partial");
  assert.match(toMarkdown(truncated), /must not be interpreted as a clean scan/);
});

test("Markdown reports are compact, action-aware, and grounded in linked verification", () => {
  const root = fixture();
  const sourceHash = sha256("const value = 1;\n");
  const result = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    evidenceRecords: [{
      schemaVersion: 1,
      id: "graph-context",
      providerId: "repository-graph",
      providerVersion: "1",
      kind: "reference",
      summary: "repository impact",
      strength: "C2",
      source: { filePath: "input.ts", line: 1, column: 1, start: 0, end: 5, sourceHash },
      details: {
        callerLocations: ["src/caller.ts:loadInput"],
        testFiles: ["tests/input.test.ts"],
        specificationFiles: ["docs/input.md"],
      },
    }],
    scannedFiles: ["input.ts"],
    findings: [
      {
        ...finding(),
        anchor: "low",
        sourceHash,
        ruleId: "structure.pass-through-wrapper",
        confidence: "C1",
        risk: "R1",
        maximumAction: "propose",
        message: "Low [link](javascript:alert(1)) *priority* <script>",
        evidence: ["low evidence"],
      },
      {
        ...finding(),
        anchor: "critical",
        sourceHash,
        ruleId: "data.hidden-catch-fallback",
        confidence: "C3",
        risk: "R3",
        message: "Critical priority finding",
        evidence: ["strong evidence"],
        counterEvidence: ["review this caveat"],
        unknown: ["runtime behavior"],
      },
      {
        ...finding(),
        anchor: "critical-copy",
        sourceHash,
        ruleId: "data.hidden-catch-fallback",
        confidence: "C2",
        risk: "R2",
        message: "Duplicate family detail should stay collapsed",
        evidence: ["duplicate evidence"],
      },
    ],
    skipped: [],
  });
  result.policyDecisions = result.findings.map((item) => ({
    findingId: item.id,
    originalConfidence: item.confidence,
    finalConfidence: item.confidence,
    originalAction: item.maximumAction,
    finalAction: item.maximumAction,
    evidenceScore: item.anchor === "critical" ? 0.95 : 0.4,
    reasons: ["deterministic policy note"],
  }));
  const markdown = toMarkdown(result, root);
  assert.ok(markdown.indexOf("data.hidden-catch-fallback") < markdown.indexOf("structure.pass-through-wrapper"));
  assert.match(markdown, /# AI-Slop Review — Human Decision Report/);
  assert.match(markdown, /\| Representative reviews \| 2 \|/);
  assert.match(markdown, /\| Actionable policy proposals \| 1 \|/);
  assert.match(markdown, /## Human Decision Summary/);
  assert.match(markdown, /## Representative Review Queue[\s\S]*\| # \| Finding family \| Candidates \| Priority \| Current disposition \| Missing evidence \| Next action \|/);
  assert.match(markdown, /\| 1 \| data\.hidden-catch-fallback \| 2 \| 99\/100 \| Observe \(2\) \| runtime behavior \| Trace consumers/);
  assert.match(markdown, /\| 2 \| structure\.pass-through-wrapper \| 1 \| 34\/100 \| Propose \(1\) \| Whether the reported behavior violates the local contract \| Inspect all callers/);
  assert.equal((markdown.match(/## Representative Outcomes/g) ?? []).length, 1);
  assert.match(markdown, /## Representative Reviews/);
  assert.match(markdown, /### Representative 1 of 2 — data\.hidden-catch-fallback/);
  assert.doesNotMatch(markdown, /## Start Here|## Findings by Family|## Finding Family Playbooks|## Representative Finding Details|## All Returned Candidates/);
  assert.doesNotMatch(markdown, /Critical-priority/);
  assert.match(markdown, /\| Review priority \| 99\/100 \|/);
  assert.match(markdown, /#### Counterevidence[\s\S]*review this caveat/);
  assert.match(markdown, /#### Decision Needed[\s\S]*> runtime behavior/);
  assert.match(markdown, /#### Missing Evidence[\s\S]*No additional evidence gaps were identified beyond the decision question/);
  assert.match(markdown, /#### Next Investigation[\s\S]*\/slop-context input\.ts[\s\S]*tests\/input\.test\.ts[\s\S]*src\/caller\.ts:loadInput[\s\S]*docs\/input\.md/);
  assert.match(markdown, /#### Policy Notes[\s\S]*deterministic policy note/);
  assert.match(markdown, /#### Record the Representative Outcome[\s\S]*applies only to this finding[\s\S]*\/slop-feedback finding:[a-f0-9]+ accepted <reason>[\s\S]*intentional <reason>[\s\S]*missing-context <reason>[\s\S]*insufficient-evidence <reason>/);
  assert.match(markdown, /#### Only If Accepted[\s\S]*\*\*Possible remediation\*\*[\s\S]*safe-looking fallback[\s\S]*\*\*Required verification\*\*[\s\S]*tests\/input\.test\.ts/);
  assert.match(markdown, /#### Representative Source[\s\S]*> 1 \| const value = 1;/);
  assert.equal((markdown.match(/#### Representative Source/g) ?? []).length, 2);
  assert.match(markdown, /\*\*Unreviewed family members:\*\* 1/);
  assert.doesNotMatch(markdown, /Duplicate family detail should stay collapsed/);
  assert.match(markdown, /\*\*Summary:\*\* 1 completed, 0 degraded, 0 failed, 0 skipped/);
  assert.doesNotMatch(markdown, /\| Provider \| Status \|/);
  assert.ok(markdown.includes("Low \\[link\\](javascript:alert(1)) \\*priority\\* &lt;script&gt;"));
  assert.doesNotMatch(markdown, /<script>/);
  const text = formatReport(result);
  assert.ok(text.indexOf("data.hidden-catch-fallback") < text.indexOf("structure.pass-through-wrapper"));
  assert.match(text, /REVIEW PRIORITY 99\/100 C3 data\.hidden-catch-fallback/);
});

test("human-facing reports expose a plain-language decision summary", () => {
  const result = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: fixture(),
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [{ ...finding(), maximumAction: "observe", message: "Review this forwarding path" }],
    evidenceRecords: [],
    skipped: [],
  });
  assert.match(toMarkdown(result), /No code change is supported by this report[\s\S]*applies to one finding, never its whole family/);
  const report = formatReport(result);
  const triage = formatTriage(result);
  assert.match(report, /Human decision required:/);
  assert.match(report, /Supporting evidence:/);
  assert.match(report, /Human must decide whether the evidence justifies any change/);
  assert.match(triage, /Summary: 1 observe/);
  assert.match(triage, /Human review action: observe/);
});

test("intent-aware triage keeps uncertainty visible and avoids removal claims", () => {
  const root = fixture();
  const result = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [
      { ...finding(), confidence: "C1", risk: "R1", maximumAction: "observe", counterEvidence: ["local convention may require this"], unknown: ["runtime intent"] },
      { ...finding(), anchor: "critical", confidence: "C3", risk: "R3", maximumAction: "propose", message: "Security-sensitive finding" },
    ],
    evidenceRecords: [{
      schemaVersion: 1,
      id: "context-evidence",
      providerId: "repository-graph",
      providerVersion: "1",
      kind: "reference",
      summary: "repository impact for exported symbol",
      strength: "C2",
      source: { filePath: "input.ts", line: 1, column: 1, start: 0, end: 5, sourceHash: "hash" },
      details: { callers: ["caller-1"], tests: ["test-1"], governingSpecifications: ["spec-1"] },
    }],
    skipped: [],
  });
  const triage = formatTriage(result);
  assert.match(triage, /Findings are evidence for human review, not proof that code is useless or removable/);
  assert.match(triage, /Evidence is incomplete or contested/);
  assert.match(triage, /Human review required; do not infer that this code is removable/);
  assert.match(triage, /Context signals inform triage only; they do not prove intent or authorize code removal/);
  assert.match(triage, /callers=1 tests=1 specifications=1 coverage=0/);
});

test("baseline deltas identify risk escalations as regression candidates", () => {
  const root = fixture();
  const baseline = createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: root,
    providerId: "test",
    providerVersion: "1",
    scannedFiles: ["input.ts"],
    findings: [finding()],
    skipped: [],
  });
  const current = {
    ...baseline,
    findings: [{ ...baseline.findings[0], risk: "R3" as const }],
  };
  const delta = diffScans(current, baseline);
  assert.equal(delta.changed.length, 1);
  assert.match(formatDelta(delta), /regression candidate/);
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
  const markdown = writeExport(root, result, "markdown", undefined, state);
  assert.equal(existsSync(output), true);
  assert.equal(existsSync(markdown), true);
  assert.match(markdown, /\.md$/);
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
test("diagnostics redact credential URLs and secret-bearing LSP arguments", () => {
  const root = fixture();
  const loaded = loadConfig(root, { globalPath: path.join(root, "missing.json") });
  loaded.config.execution.lspServers.typescript = [
    process.execPath,
    "--token", "token-value",
    "https://user:password@example.test/?api_key=key-value",
  ];
  loaded.warnings.push("credential=https://user:password@example.test");
  const report = diagnose(root, loaded);
  const details = report.checks.map((check) => check.detail).join("\n") + report.warnings.join("\n");
  assert.equal(details.includes("token-value"), false);
  assert.equal(details.includes("password@example"), false);
  assert.equal(details.includes("key-value"), false);
  assert.equal(redactSensitive("--password hunter"), "--password <redacted>");
  assert.equal(report.ok, false);
});

test("redaction covers authorization headers, AWS credentials, and JSON secret fields", () => {
  const value = redactSensitive(
    'Authorization: Bearer bearer-secret AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP AWS_SECRET_ACCESS_KEY=aws-secret {"password":"json-secret","clientSecret":"another-secret","accessKeyId":"json-aws-id"}',
  );
  assert.equal(value.includes("bearer-secret"), false);
  assert.equal(value.includes("aws-secret"), false);
  assert.equal(value.includes("json-aws-id"), false);
  assert.equal(value.includes("json-secret"), false);
  assert.equal(value.includes("another-secret"), false);
  assert.deepEqual(redactConfig({ token: "json-secret", safe: "value" }), { token: "<redacted>", safe: "value" });
});
