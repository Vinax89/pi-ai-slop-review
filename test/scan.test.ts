import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { scanFiles } from "../src/scan.ts";

test("combines TypeScript and Python findings without losing provider evidence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-combined-"));
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }),
  );
  writeFileSync(
    path.join(root, "input.ts"),
    "function load(id: string) { return id; }\nfunction wrapper(id: string) { return load(id); }\nwrapper('x');\n",
  );
  writeFileSync(path.join(root, "input.py"), "import surely_missing_package\n");

  const result = await scanFiles(root, ["input.ts", "input.py"]);
  assert.equal(result.engine, "provider-federation");
  assert.match(result.engineVersion, /typescript .*; python /);
  assert.deepEqual(result.scannedFiles, ["input.py", "input.ts"]);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map((finding) => [finding.filePath, finding.ruleId]),
    [
      ["input.py", "dependency.unresolved"],
      ["input.ts", "structure.pass-through-wrapper"],
    ],
  );
});

test("repository mode graph-processes documentation and manifests without changed-symbol test noise", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-repository-"));
  const state = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-state-"));
  writeFileSync(path.join(root, "input.ts"), "export function value() { return 1; }\n");
  writeFileSync(path.join(root, "README.md"), "# Contract\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", exports: "./input.ts" }));
  const result = await scanFiles(root, ["README.md", "input.ts", "package.json"], undefined, "repository", {
    graphStateRoot: state,
    policyStateRoot: state,
  });
  assert.deepEqual(result.scannedFiles, ["README.md", "input.ts", "package.json"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.findings.some((finding) => finding.ruleId === "assurance.no-linked-tests"), false);
});

test("reports unsupported files without blocking supported files", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-combined-"));
  writeFileSync(path.join(root, "input.py"), "import os\n");
  writeFileSync(path.join(root, "notes.txt"), "text\n");
  const result = await scanFiles(root, ["input.py", "notes.txt"]);
  assert.deepEqual(result.scannedFiles, ["input.py"]);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /unsupported/);
});
