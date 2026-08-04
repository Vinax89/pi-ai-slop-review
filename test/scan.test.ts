import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { isolatedScanMetrics, resetIsolatedScanWorker, scanFilesIsolated } from "../src/isolated-scan.ts";
import { scanFiles } from "../src/scan.ts";

test("isolated scans contain worker failures and return an abstention", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-isolated-failure-"));
  const worker = path.join(root, "failing-worker.mjs");
  writeFileSync(path.join(root, "input.ts"), "export const value = 1;\n");
  writeFileSync(worker, "throw new Error('worker failed');\n");

  const result = await scanFilesIsolated(
    root,
    ["input.ts"],
    undefined,
    "explicit",
    {},
    { workerUrl: pathToFileURL(worker), maxOldGenerationSizeMb: 64 },
  );

  assert.equal(result.completeness?.status, "abstained");
  assert.equal(result.providers[0]?.status, "failed");
  assert.match(result.skipped[0]?.reason ?? "", /resource budget/);
});

test("isolated scans preempt synchronous work at the hard deadline", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-worker-deadline-"));
  const worker = path.join(root, "blocking-worker.mjs");
  writeFileSync(path.join(root, "input.ts"), "export const value = 1;\n");
  writeFileSync(worker, "import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => { while (true) {} });\n");

  const result = await scanFilesIsolated(
    root,
    ["input.ts"],
    undefined,
    "explicit",
    {},
    { workerUrl: pathToFileURL(worker), maxOldGenerationSizeMb: 64, timeoutMs: 50 },
  );

  assert.equal(result.completeness?.status, "abstained");
  assert.match(result.skipped[0]?.reason ?? "", /time or CPU budget/);
});

test("isolated scans retry one infrastructure failure in a fresh worker", async () => {
  await resetIsolatedScanWorker();
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-worker-retry-"));
  const worker = path.join(root, "retry-worker.ts");
  const marker = path.join(root, "failed-once");
  writeFileSync(path.join(root, "input.ts"), "export const value = 1;\n");
  writeFileSync(worker, `
    import { existsSync, writeFileSync } from "node:fs";
    import { parentPort } from "node:worker_threads";
    import { createScanResult } from ${JSON.stringify(pathToFileURL(path.resolve("src/core/schema.ts")).href)};
    parentPort?.on("message", (message) => {
      if (!existsSync(${JSON.stringify(marker)})) {
        writeFileSync(${JSON.stringify(marker)}, "failed");
        process.exit(1);
      }
      parentPort?.postMessage({
        id: message.id,
        result: createScanResult({
          engine: "typescript-semantic",
          engineVersion: "retry",
          rootDir: message.request.rootDir,
          mode: message.request.mode,
          providerId: "typescript-semantic",
          providerVersion: "retry",
          scannedFiles: ["input.ts"],
          findings: [],
          skipped: [],
        }),
        metrics: { cacheHit: false, cpuMs: 0, heapUsedMiB: 1, rssMiB: 1 },
      });
    });
  `);

  const result = await scanFilesIsolated(root, ["input.ts"], undefined, "explicit", {}, {
    workerUrl: pathToFileURL(worker),
    maxOldGenerationSizeMb: 64,
  });
  assert.equal(result.completeness?.status, "complete");
  assert.deepEqual(result.scannedFiles, ["input.ts"]);
  await resetIsolatedScanWorker();
});

test("isolated scans return successful worker results", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-isolated-success-"));
  const state = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-isolated-state-"));
  writeFileSync(path.join(root, "input.ts"), "export const value = 1;\n");

  const result = await scanFilesIsolated(root, ["input.ts"], undefined, "explicit", {
    graphStateRoot: state,
    policyStateRoot: state,
  });

  assert.deepEqual(result.scannedFiles, ["input.ts"]);
  assert.equal(result.completeness?.status, "complete");
});

test("isolated worker caches unchanged scans and invalidates changed source", async () => {
  await resetIsolatedScanWorker();
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-worker-cache-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.graph.enabled = false;
  writeFileSync(path.join(root, "input.ts"), "export const value = 1;\n");

  await scanFilesIsolated(root, ["input.ts"], undefined, "explicit", { config });
  assert.equal(isolatedScanMetrics()?.cacheHit, false);
  await scanFilesIsolated(root, ["input.ts"], undefined, "explicit", { config });
  assert.equal(isolatedScanMetrics()?.cacheHit, true);

  writeFileSync(path.join(root, "input.ts"), "export const value = ;\n");
  const changed = await scanFilesIsolated(root, ["input.ts"], undefined, "explicit", { config });
  assert.equal(isolatedScanMetrics()?.cacheHit, false);
  assert.ok((isolatedScanMetrics()?.programsReused ?? 0) > 0);
  assert.match(changed.skipped[0]?.reason ?? "", /syntax diagnostics/);
  await resetIsolatedScanWorker();
});

test("isolated worker invalidates cached programs when tsconfig changes", async () => {
  await resetIsolatedScanWorker();
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-worker-config-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.graph.enabled = false;
  writeFileSync(path.join(root, "input.ts"), "export const value = 1;\n");
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));

  await scanFilesIsolated(root, ["input.ts"], undefined, "explicit", { config });
  await scanFilesIsolated(root, ["input.ts"], undefined, "explicit", { config });
  assert.equal(isolatedScanMetrics()?.cacheHit, true);
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: false } }));
  await scanFilesIsolated(root, ["input.ts"], undefined, "explicit", { config });
  assert.equal(isolatedScanMetrics()?.cacheHit, false);
  assert.equal(isolatedScanMetrics()?.programsReused, 0);
  await resetIsolatedScanWorker();
});

test("isolated worker recycles at its configured job threshold", async () => {
  await resetIsolatedScanWorker();
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-worker-recycle-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.graph.enabled = false;
  writeFileSync(path.join(root, "input.ts"), "export const value = 1;\n");
  const runtime = { maxJobs: 1 };

  await scanFilesIsolated(root, ["input.ts"], undefined, "explicit", { config }, runtime);
  await scanFilesIsolated(root, ["input.ts"], undefined, "explicit", { config }, runtime);
  assert.equal(isolatedScanMetrics()?.cacheHit, false);
  await resetIsolatedScanWorker();
});

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

test("scan reports partial results when its resource budget is exhausted", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-budget-"));
  writeFileSync(path.join(root, "input.ts"), "export const value = 1;\n");
  const config = structuredClone(DEFAULT_CONFIG);
  config.graph.enabled = false;
  const result = await scanFiles(root, ["input.ts"], undefined, "explicit", { config, memoryBudgetBytes: 1 });
  assert.equal(result.completeness?.status, "partial");
  assert.ok(result.providers.some((provider) => provider.id === "resource-budget" && provider.status === "skipped"));
  assert.ok(result.skipped.some((item) => /memory budget exhausted/.test(item.reason)));
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

test("scan canonicalizes aliases and enforces configured native file limits", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-limits-"));
  writeFileSync(path.join(root, "input.ts"), "const value = 1;\n");
  const config = structuredClone(DEFAULT_CONFIG);
  config.limits.maxFileBytes = 4;
  const result = await scanFiles(root, ["@./input.ts", path.join(root, "input.ts")], undefined, "explicit", { config });
  assert.deepEqual(result.scannedFiles, []);
  assert.equal(result.skipped.filter((item) => item.filePath === "input.ts").length, 1);
  assert.match(result.skipped.find((item) => item.filePath === "input.ts")?.reason ?? "", /configured limit/);
});

test("scan abort signal prevents native providers from scanning", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-abort-"));
  writeFileSync(path.join(root, "input.ts"), "const value = 1;\n");
  const controller = new AbortController();
  controller.abort();
  const result = await scanFiles(root, ["input.ts"], controller.signal);
  assert.equal(result.scannedFiles.length, 0);
  assert.equal(result.completeness?.status, "abstained");
  assert.ok(result.skipped.some((item) => /aborted/.test(item.reason)));
});
