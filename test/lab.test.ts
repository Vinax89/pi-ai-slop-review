import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG, type AiSlopConfig } from "../src/core/config.ts";
import { applyProposal, createProposal, listLaboratory, rollbackProposal, validateProposal } from "../src/lab.ts";

function repository(): { root: string; state: string; config: AiSlopConfig; command: string[] } {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-lab-repo-"));
  const state = mkdtempSync(path.join(tmpdir(), "ai-slop-lab-state-"));
  writeFileSync(path.join(root, "input.txt"), "value=one\n");
  writeFileSync(
    path.join(root, "verify.cjs"),
    "const fs=require('node:fs'); if(process.env.AI_SLOP_SECRET) throw new Error('secret leaked'); if(!/^value=(one|two)$/.test(fs.readFileSync('input.txt','utf8').trim())) throw new Error('bad value'); console.log('secret=absent');\n",
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
  return { root, state, config, command };
}

function patch(): string {
  return "diff --git a/input.txt b/input.txt\n--- a/input.txt\n+++ b/input.txt\n@@ -1 +1 @@\n-value=one\n+value=two\n";
}

test("laboratory validates baseline and candidate in separate network-isolated, secret-scrubbed worktrees", async () => {
  const { root, state, config, command } = repository();
  process.env.AI_SLOP_SECRET = "must-not-leak";
  try {
    const proposal = await createProposal(
      root,
      {
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
    assert.equal(readFileSync(path.join(root, "input.txt"), "utf8"), "value=one\n");
    assert.equal(listLaboratory(root, state).proposals[0].status, "verified");
  } finally {
    delete process.env.AI_SLOP_SECRET;
  }
});

test("explicit application is hash-guarded and reversible", async () => {
  const { root, state, config, command } = repository();
  const proposal = await createProposal(
    root,
    { patch: patch(), risk: "R2", proofObligations: ["verification passes"], commands: [command] },
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
  const staleProposal = await createProposal(
    stale.root,
    { patch: patch(), risk: "R2", proofObligations: ["verification passes"], commands: [stale.command] },
    stale.config,
    stale.state,
  );
  await validateProposal(stale.root, staleProposal.id, stale.config, true, undefined, stale.state);
  writeFileSync(path.join(stale.root, "input.txt"), "value=changed\n");
  await assert.rejects(() => applyProposal(stale.root, staleProposal.id, stale.state), /source hash changed/);

  const risky = repository();
  const riskyProposal = await createProposal(
    risky.root,
    { patch: patch(), risk: "R3", proofObligations: ["verification passes"], commands: [risky.command] },
    risky.config,
    risky.state,
  );
  await validateProposal(risky.root, riskyProposal.id, risky.config, true, undefined, risky.state);
  await assert.rejects(() => applyProposal(risky.root, riskyProposal.id, risky.state), /R3/);

  const deletion = repository();
  const deletePatch = "diff --git a/input.txt b/input.txt\ndeleted file mode 100644\n--- a/input.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-value=one\n";
  const deleteProposal = await createProposal(
    deletion.root,
    { patch: deletePatch, risk: "R2", proofObligations: ["verification passes"], commands: [deletion.command] },
    deletion.config,
    deletion.state,
  );
  assert.equal(deleteProposal.deletesFiles, true);

  const critical = repository();
  mkdirSync(path.join(critical.root, "security"));
  writeFileSync(path.join(critical.root, "security/input.txt"), "value=one\n");
  execFileSync("git", ["add", "security/input.txt"], { cwd: critical.root });
  execFileSync("git", ["commit", "-qm", "security fixture"], { cwd: critical.root });
  const criticalPatch = "diff --git a/security/input.txt b/security/input.txt\n--- a/security/input.txt\n+++ b/security/input.txt\n@@ -1 +1 @@\n-value=one\n+value=two\n";
  const criticalProposal = await createProposal(
    critical.root,
    { patch: criticalPatch, risk: "R2", proofObligations: ["verification passes"], commands: [critical.command] },
    critical.config,
    critical.state,
  );
  assert.deepEqual(criticalProposal.criticalPaths, ["security/input.txt"]);
  await validateProposal(critical.root, criticalProposal.id, critical.config, true, undefined, critical.state);
  await assert.rejects(() => applyProposal(critical.root, criticalProposal.id, critical.state), /critical-path/);
});

test("laboratory rejects untrusted execution and non-allowlisted commands before running", async () => {
  const { root, state, config, command } = repository();
  await assert.rejects(
    () => createProposal(root, { patch: patch(), risk: "R2", proofObligations: ["check"], commands: [["sh", "-c", "true"]] }, config, state),
    /not allowlisted/,
  );
  const proposal = await createProposal(root, { patch: patch(), risk: "R2", proofObligations: ["check"], commands: [command] }, config, state);
  await assert.rejects(() => validateProposal(root, proposal.id, config, false, undefined, state), /requires Pi project trust/);
});
