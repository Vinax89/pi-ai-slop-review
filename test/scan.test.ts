import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.ts";
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

test("batches large Python scans below process argument limits", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-python-batches-"));
  const state = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-python-batch-state-"));
  const python = path.join(root, "python-batch-guard.sh");
  writeFileSync(python, "#!/bin/sh\n[ \"$#\" -le 504 ] || exit 64\nexec python3 \"$@\"\n");
  chmodSync(python, 0o700);
  const paths = Array.from({ length: 501 }, (_, index) => `value-${index}.py`);
  for (const [index, filePath] of paths.entries()) writeFileSync(path.join(root, filePath), `value = ${index}\n`);
  const previousPython = process.env.PI_AI_SLOP_PYTHON;
  process.env.PI_AI_SLOP_PYTHON = python;
  try {
    const result = await scanFiles(root, paths, undefined, "repository", { graphStateRoot: state, policyStateRoot: state });
    assert.equal(result.scannedFiles.length, paths.length);
    assert.deepEqual(result.skipped, []);
  } finally {
    if (previousPython === undefined) delete process.env.PI_AI_SLOP_PYTHON;
    else process.env.PI_AI_SLOP_PYTHON = previousPython;
  }
});

test("caps findings by weighted priority and reports the omission", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-finding-limit-"));
  const state = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-finding-limit-state-"));
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" } }));
  writeFileSync(
    path.join(root, "input.ts"),
    "import missing from 'surely-missing-package';\nfunction load(value: string) { return value; }\nfunction wrapper(value: string) { return load(value); }\nwrapper(String(missing));\n",
  );
  const config = structuredClone(DEFAULT_CONFIG);
  config.limits.maxFindings = 1;
  const result = await scanFiles(root, ["input.ts"], undefined, "explicit", {
    config,
    graphStateRoot: state,
    policyStateRoot: state,
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].ruleId, "dependency.unresolved");
  assert.match(result.skipped.find((item) => item.filePath === "<findings>")?.reason ?? "", /1 finding\(s\) omitted/);
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
