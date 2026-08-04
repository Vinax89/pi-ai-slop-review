import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, type AiSlopConfig } from "../src/core/config.ts";
import { createFinding, createScanResult, sha256 } from "../src/core/schema.ts";
import { isExactConfiguredCommand, restrictedRuntime, splitCommand } from "../src/core/execution.ts";
import { StateStore } from "../src/core/store.ts";
import { applyProposal, createProposal, listLaboratory, rollbackProposal, validateProposal } from "../src/lab.ts";
import { applyPolicy } from "../src/policy/engine.ts";

function repository(hostSecretPath?: string): { root: string; state: string; config: AiSlopConfig; command: string[] } {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-lab-repo-"));
  const state = mkdtempSync(path.join(tmpdir(), "ai-slop-lab-state-"));
  writeFileSync(path.join(root, "input.txt"), "value=one\n");
  const hostProbe = hostSecretPath
    ? `try { fs.readFileSync(${JSON.stringify(hostSecretPath)}); throw new Error('host secret visible'); } catch (error) { if (error.message === 'host secret visible') throw error; }`
    : "";
  writeFileSync(
    path.join(root, "verify.cjs"),
    `const fs=require('node:fs'); if(process.env.AI_SLOP_SECRET) throw new Error('secret leaked'); ${hostProbe} if(!/^value=(one|two)$/.test(fs.readFileSync('input.txt','utf8').trim())) throw new Error('bad value'); console.log('secret=absent\\nAuthorization: Bearer validator-secret');\n`,
  );
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  execFileSync("git", ["add", "input.txt", "verify.cjs"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  const command = [process.execPath, "verify.cjs"];
  const config = structuredClone(DEFAULT_CONFIG);
  config.execution.trusted = true;

  config.execution.commands = [command.join(" ")];
  authorizeReview(root, state, config, "input.txt");
  return { root, state, config, command };
}
function authorizeReview(root: string, stateRoot: string, config: AiSlopConfig, filePath: string): string {
  const { finding, evidenceRecords } = createFinding({
    anchor: `function:authorized-${filePath}`,
    ruleId: "structure.pass-through-wrapper",
    classification: "waste_candidate",
    confidence: "C2",
    risk: "R2",
    maximumAction: "propose",
    filePath,
    line: 1,
    column: 1,
    start: 0,
    end: 1,
    sourceHash: sha256(readFileSync(path.join(root, filePath))),
    message: "authorized fixture finding",
    evidence: ["fixture positive evidence"],
    counterEvidence: [],
    unknown: [],
  }, "fixture-provider", "1");
  const scan = createScanResult({
    engine: "provider-federation",
    engineVersion: "test",
    rootDir: root,
    providerId: "fixture-provider",
    providerVersion: "1",
    providerCapabilities: ["references"],
    scannedFiles: [filePath],
    findings: [finding],
    evidenceRecords,
    skipped: [],
  });
  const reviewed = applyPolicy(root, scan, config, stateRoot);
  new StateStore(root, stateRoot).update((state) => {
    state.baselines["last-review"] = reviewed;
  });
  return finding.id;
}
function reviewFindingId(root: string, stateRoot: string): string {
  return new StateStore(root, stateRoot).load().baselines["last-review"].findings[0].id;
}

function patch(): string {
  return "diff --git a/input.txt b/input.txt\n--- a/input.txt\n+++ b/input.txt\n@@ -1 +1 @@\n-value=one\n+value=two\n";
}

test("laboratory validates baseline and candidate without ambient host-secret access", async () => {
  const secretDirectory = mkdtempSync(path.join(homedir(), ".ai-slop-host-secret-"));
  const secretPath = path.join(secretDirectory, "secret.txt");
  writeFileSync(secretPath, "must-not-be-readable\n");
  const { root, state, config, command } = repository(secretPath);
  process.env.AI_SLOP_SECRET = "must-not-leak";
  const findingId = reviewFindingId(root, state);
  try {
    const proposal = await createProposal(
      root,
      {
        findingIds: [findingId],
        patch: patch(),
        risk: "R2",
        proofObligations: ["verification command passes before and after", "bounded expression behavior is equivalent"],
        commands: [command],
        experiments: [{
          id: "identity",
          kind: "expression-equivalence",
          original: "x + 0",
          candidate: "x",
          variables: [{ name: "x", type: "integer", minimum: -5, maximum: 5 }],
          properties: [],
          metamorphic: [],
          maximumCases: 100,
        }],
      },
      config,
      state,
    );
    const run = await validateProposal(root, proposal.id, config, true, undefined, state);
    assert.equal(run.status, "verified");
    assert.equal(run.networkIsolation, "bubblewrap");
    assert.equal(run.publicSurfaceChanged, false);
    assert.equal(run.experimentResults[0].status, "verified");
    assert.equal(run.checks.filter((check) => check.phase === "baseline" && check.succeeded).length, 1);
    assert.equal(run.checks.filter((check) => check.phase === "candidate" && check.succeeded).length, 2);
    assert.ok(run.checks.filter((check) => check.command).every((check) => check.output.includes("secret=absent")));
    assert.equal(run.checks.some((check) => check.output.includes("validator-secret")), false);
    assert.equal(readFileSync(path.join(root, "input.txt"), "utf8"), "value=one\n");
    assert.equal(listLaboratory(root, state).proposals[0].status, "verified");
    const persisted = new StateStore(root, state).load();
    assert.equal(JSON.stringify(persisted).includes("validator-secret"), false);
  } finally {
    delete process.env.AI_SLOP_SECRET;
    rmSync(secretDirectory, { recursive: true, force: true });
  }
});

test("explicit application is hash-guarded and reversible", async () => {
  const { root, state, config, command } = repository();
  const findingId = reviewFindingId(root, state);
  const proposal = await createProposal(
    root,
    { patch: patch(), findingIds: [findingId], risk: "R2", proofObligations: ["verification passes"], commands: [command] },
    config,
    state,
  );
  assert.equal((await validateProposal(root, proposal.id, config, true, undefined, state)).status, "verified");
  await applyProposal(root, proposal.id, state);
  assert.equal(readFileSync(path.join(root, "input.txt"), "utf8"), "value=two\n");
  await rollbackProposal(root, proposal.id, state);
  assert.equal(readFileSync(path.join(root, "input.txt"), "utf8"), "value=one\n");
  assert.equal(listLaboratory(root, state).proposals[0].status, "rolled-back");
});

test("application rejects stale hashes, file deletion, critical paths, and R3 proposals", async () => {
  const stale = repository();
  const staleFindingId = reviewFindingId(stale.root, stale.state);
  const staleProposal = await createProposal(
    stale.root,
    { patch: patch(), findingIds: [staleFindingId], risk: "R2", proofObligations: ["verification passes"], commands: [stale.command] },
    stale.config,
    stale.state,
  );
  await validateProposal(stale.root, staleProposal.id, stale.config, true, undefined, stale.state);
  writeFileSync(path.join(stale.root, "input.txt"), "value=changed\n");
  await assert.rejects(() => applyProposal(stale.root, staleProposal.id, stale.state), /source hash changed/);

  const risky = repository();
  await assert.rejects(
    () => createProposal(risky.root, { patch: patch(), findingIds: [reviewFindingId(risky.root, risky.state)], risk: "R3", proofObligations: ["verification passes"], commands: [risky.command] }, risky.config, risky.state),
    /exceeds finding/,
  );

  const deletion = repository();
  const deletePatch = "diff --git a/input.txt b/input.txt\ndeleted file mode 100644\n--- a/input.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-value=one\n";
  const deleteProposal = await createProposal(
    deletion.root,
    { patch: deletePatch, findingIds: [reviewFindingId(deletion.root, deletion.state)], risk: "R2", proofObligations: ["verification passes"], commands: [deletion.command] },
    deletion.config,
    deletion.state,
  );
  assert.equal(deleteProposal.deletesFiles, true);

  const critical = repository();
  mkdirSync(path.join(critical.root, "security"));
  writeFileSync(path.join(critical.root, "security/input.txt"), "value=one\n");
  execFileSync("git", ["add", "security/input.txt"], { cwd: critical.root });
  execFileSync("git", ["commit", "-qm", "security fixture"], { cwd: critical.root });
  const criticalFindingId = authorizeReview(critical.root, critical.state, critical.config, "security/input.txt");
  const criticalPatch = "diff --git a/security/input.txt b/security/input.txt\n--- a/security/input.txt\n+++ b/security/input.txt\n@@ -1 +1 @@\n-value=one\n+value=two\n";
  const criticalProposal = await createProposal(
    critical.root,
    { patch: criticalPatch, findingIds: [criticalFindingId], risk: "R2", proofObligations: ["verification passes"], commands: [critical.command] },
    critical.config,
    critical.state,
  );
  assert.deepEqual(criticalProposal.criticalPaths, ["security/input.txt"]);
  await validateProposal(critical.root, criticalProposal.id, critical.config, true, undefined, critical.state);
  await assert.rejects(() => applyProposal(critical.root, criticalProposal.id, critical.state), /critical-path/);
});

test("exact command authorization preserves empty arguments", () => {
  assert.deepEqual(splitCommand("validator \"\""), ["validator", ""]);
  assert.equal(isExactConfiguredCommand(["validator"], ["validator \"\""]), false);
  assert.equal(isExactConfiguredCommand(["validator", ""], ["validator \"\""]), true);
});
test("restricted execution rejects symlinked executables before sandbox setup", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-command-isolation-"));
  const executable = path.join(root, "validator");
  const link = path.join(root, "link");
  writeFileSync(executable, "#!/bin/sh\n");
  chmodSync(executable, 0o700);
  symlinkSync(executable, link);
  assert.throws(() => restrictedRuntime([link], root), /configured executable was not found/);
});

test("proposal creation requires latest-review authority and current HEAD", async () => {
  const { root, state, config, command } = repository();
  await assert.rejects(
    () => createProposal(root, { patch: patch(), risk: "R2", proofObligations: ["check"], commands: [command] }, config, state),
    /requires at least one latest-review finding ID/,
  );
  await assert.rejects(
    () => createProposal(root, { patch: patch(), findingIds: ["finding:missing"], risk: "R2", proofObligations: ["check"], commands: [command] }, config, state),
    /was not found in the latest review/,
  );
  const proposal = await createProposal(root, { patch: patch(), findingIds: [reviewFindingId(root, state)], risk: "R2", proofObligations: ["check"], commands: [command] }, config, state);
  writeFileSync(path.join(root, "unrelated.txt"), "committed after proposal\n");
  execFileSync("git", ["add", "unrelated.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "advance HEAD"], { cwd: root });
  await assert.rejects(
    () => validateProposal(root, proposal.id, config, true, undefined, state),
    /base commit .* current HEAD/,
  );
});

test("laboratory rejects untrusted execution and commands outside exact configuration", async () => {
  const { root, state, config, command } = repository();
  await assert.rejects(
    () => createProposal(root, { patch: patch(), risk: "R2", proofObligations: ["check"], commands: [["sh", "-c", "true"]] }, config, state),
    /not an exact execution\.commands entry/,
  );
  await assert.rejects(
    () => createProposal(root, { patch: patch(), risk: "R2", proofObligations: ["check"], commands: [[...command, "--extra"]] }, config, state),
    /not an exact execution\.commands entry/,
  );
  const proposal = await createProposal(root, { patch: patch(), findingIds: [reviewFindingId(root, state)], risk: "R2", proofObligations: ["check"], commands: [command] }, config, state);
  await assert.rejects(() => validateProposal(root, proposal.id, config, false, undefined, state), /requires Pi project trust/);
});

test("cancelled validation remains distinct and does not authorize application", async () => {
  const { root, state, config, command } = repository();
  const proposal = await createProposal(
    root,
    { patch: patch(), findingIds: [reviewFindingId(root, state)], risk: "R2", proofObligations: ["verification passes"], commands: [command] },
    config,
    state,
  );
  const controller = new AbortController();
  controller.abort();
  const run = await validateProposal(root, proposal.id, config, true, controller.signal, state);
  assert.equal(run.status, "cancelled");
  assert.equal(listLaboratory(root, state).proposals[0].status, "candidate");
  await assert.rejects(() => applyProposal(root, proposal.id, state), /no current verified laboratory run/);
});

test("ambiguous proposal prefixes are rejected before authorization", async () => {
  const { root, state, config, command } = repository();
  const findingId = reviewFindingId(root, state);
  await createProposal(root, { patch: patch(), findingIds: [findingId], risk: "R2", proofObligations: ["first"], commands: [command] }, config, state);
  await createProposal(root, { patch: patch(), findingIds: [findingId], risk: "R2", proofObligations: ["second"], commands: [command] }, config, state);
  await assert.rejects(() => validateProposal(root, "proposal:", config, true, undefined, state), /proposal prefix 'proposal:' is ambiguous/);
});
