import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/lifecycle.mjs", import.meta.url).pathname;
const source = new URL("..", import.meta.url).pathname;

function run(root: string, action: string, ...args: string[]): any {
  const result = spawnSync(process.execPath, [script, action, ...args, "--root", root], {
    encoding: "utf8",
    timeout: 180_000,
    env: { ...process.env, PI_AI_SLOP_LIFECYCLE_TEST: "1" },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

test("lifecycle supports atomic install, update, disable, enable, uninstall, and separate state purge", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ai-slop-lifecycle-"));
  const installed = run(root, "install", source);
  assert.equal(installed.installed ?? true, true);
  assert.equal(installed.version, "1.0.0");
  assert.equal(existsSync(path.join(root, "ai-slop/index.ts")), true);
  assert.equal(existsSync(path.join(root, "ai-slop/node_modules/typescript/package.json")), true);
  assert.equal(run(root, "status").enabled, true);
  assert.equal(run(root, "disable").enabled, false);
  assert.equal(run(root, "enable").enabled, true);
  assert.equal(run(root, "update", source).version, "1.0.0");
  const removed = run(root, "uninstall");
  assert.equal(removed.statePreserved, true);
  assert.equal(existsSync(path.join(root, "ai-slop")), false);
  assert.equal(run(root, "purge-state").stateRemoved, true);
});
