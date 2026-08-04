import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/lifecycle.mjs", import.meta.url).pathname;
const source = new URL("..", import.meta.url).pathname;
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function run(root: string, action: string, ...args: string[]): any {
  const result = spawnSync(process.execPath, [script, action, ...args, "--root", root], {
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, PI_AI_SLOP_LIFECYCLE_TEST: "1" },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}
function runFailure(root: string, action: string, ...args: string[]): string {
  const result = spawnSync(process.execPath, [script, action, ...args, "--root", root], {
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, PI_AI_SLOP_LIFECYCLE_TEST: "1" },
  });
  assert.notEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return `${result.stderr}\n${result.stdout}`;
}


test("lifecycle supports atomic install, update, disable, enable, uninstall, and separate state purge", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-lifecycle-"));
  const installed = run(root, "install", source);
  assert.equal(installed.installed ?? true, true);
  assert.equal(installed.version, version);
  assert.equal(existsSync(path.join(root, "ai-slop/index.ts")), true);
  assert.equal(existsSync(path.join(root, "ai-slop/node_modules/typescript/package.json")), true);
  assert.equal(run(root, "status").enabled, true);
  assert.equal(run(root, "disable").enabled, false);
  assert.equal(run(root, "enable").enabled, true);
  assert.equal(run(root, "update", source).version, version);
  const removed = run(root, "uninstall");
  assert.equal(removed.statePreserved, true);
  assert.equal(existsSync(path.join(root, "ai-slop")), false);
  assert.equal(run(root, "purge-state").stateRemoved, true);
});
test("lifecycle rejects symlinked markers and preserves the active target after promotion failure", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-lifecycle-safe-"));
  run(root, "install", source);
  const target = path.join(root, "ai-slop");
  const secret = path.join(root, "marker-secret");
  writeFileSync(secret, "must remain unchanged\n");
  symlinkSync(secret, path.join(target, ".disabled"));
  runFailure(root, "disable");
  assert.equal(readFileSync(secret, "utf8"), "must remain unchanged\n");
  rmSync(path.join(target, ".disabled"));

  const brokenSource = mkdtempSync(path.join(tmpdir(), "ai-slop-lifecycle-source-"));
  mkdirSync(brokenSource, { recursive: true });
  writeFileSync(path.join(brokenSource, "package.json"), "{ malformed");
  writeFileSync(path.join(brokenSource, "index.ts"), "export {};\n");
  const previousManifest = readFileSync(path.join(target, "package.json"), "utf8");
  runFailure(root, "update", brokenSource);
  assert.equal(readFileSync(path.join(target, "package.json"), "utf8"), previousManifest);
  assert.equal(lstatSync(target).isDirectory(), true);
});

test("lifecycle fails closed when the per-target operation lock is held", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-lifecycle-lock-"));
  const lock = path.join(root, ".ai-slop-ai-slop.lock");
  writeFileSync(lock, "held\n", { mode: 0o600 });
  assert.match(runFailure(root, "status"), /another lifecycle operation is already in progress/);
  rmSync(lock);
});
