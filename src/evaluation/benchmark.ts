import { mkdirSync, mkdtempSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DEFAULT_CONFIG } from "../core/config.ts";
import { queryContext } from "../graph/query.ts";
import { isolatedScanMetrics, resetIsolatedScanWorker, scanFilesIsolated } from "../isolated-scan.ts";
import { evaluationInputHashes, evaluationRuntimeMetadata } from "./artifacts.ts";
function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

const maybeGc = (globalThis as unknown as { gc?: () => void }).gc;
const root = mkdtempSync(path.join(tmpdir(), "ai-slop-benchmark-"));
const graphStateRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-benchmark-graph-"));
const policyStateRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-benchmark-policy-"));
const largeRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-benchmark-large-"));
try {
  mkdirSync(path.join(root, "src"));
  const paths: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    const filePath = `src/module-${index}.ts`;
    paths.push(filePath);
    writeFileSync(
      path.join(root, filePath),
      `${index ? `import { value${index - 1} } from './module-${index - 1}.js';\n` : ""}export function value${index}(input: number) { return input + ${index}${index ? ` + value${index - 1}(0)` : ""}; }\n`,
    );
  }
  writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src/**/*.ts"] }));
  const config = structuredClone(DEFAULT_CONFIG);
  const options = { config, graphStateRoot, policyStateRoot };
  maybeGc?.();
  const memoryBefore = process.memoryUsage();
  const coldStarted = performance.now();
  const cold = await scanFilesIsolated(root, paths, undefined, "repository", options);
  const coldMs = performance.now() - coldStarted;
  const coldFindingIds = cold.findings.map((finding) => finding.id);
  const expectedPaths = [...paths].sort();
  if (
    cold.scannedFiles.length !== paths.length ||
    JSON.stringify([...cold.scannedFiles].sort()) !== JSON.stringify(expectedPaths) ||
    cold.completeness?.scannedFiles !== paths.length ||
    cold.skipped.length !== 0 ||
    cold.completeness?.status !== "complete" ||
    cold.findings.length !== 0 ||
    coldFindingIds.length !== 0
  ) {
    throw new Error("benchmark cold scan failed correctness or completeness invariants");
  }
  const coldWorker = isolatedScanMetrics();
  const warmTimes: number[] = [];
  const warmCacheHits: boolean[] = [];
  const warmCpuTimes: number[] = [];
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const started = performance.now();
    const warm = await scanFilesIsolated(root, paths, undefined, "repository", options);
    if (
      warm.scannedFiles.length !== paths.length ||
      JSON.stringify([...warm.scannedFiles].sort()) !== JSON.stringify(expectedPaths) ||
      warm.completeness?.scannedFiles !== paths.length ||
      warm.skipped.length !== 0 ||
      warm.completeness?.status !== "complete" ||
      warm.findings.length !== cold.findings.length ||
      JSON.stringify(warm.findings.map((finding) => finding.id)) !== JSON.stringify(coldFindingIds) ||
      JSON.stringify(warm.completeness) !== JSON.stringify(cold.completeness)
    ) {
      throw new Error("benchmark warm scan failed correctness or completeness invariants");
    }
    warmTimes.push(performance.now() - started);
    const metrics = isolatedScanMetrics();
    warmCacheHits.push(Boolean(metrics?.cacheHit));
    if (metrics) warmCpuTimes.push(metrics.cpuMs);
    maybeGc?.();
  }
  await resetIsolatedScanWorker();
  const recycledStarted = performance.now();
  const recycled = await scanFilesIsolated(root, paths, undefined, "repository", options);
  const recycledColdScanMs = performance.now() - recycledStarted;
  if (
    recycled.completeness?.status !== "complete" ||
    recycled.scannedFiles.length !== paths.length ||
    recycled.skipped.length !== 0 ||
    JSON.stringify(recycled.findings.map((finding) => finding.id)) !== JSON.stringify(coldFindingIds) ||
    isolatedScanMetrics()?.cacheHit
  ) {
    throw new Error("benchmark recycled scan failed correctness or cache-reset invariants");
  }
  writeFileSync(path.join(root, "src/module-39.ts"), "export function value39(input: number) { return input + 40; }\n");
  const changedStarted = performance.now();
  const changed = await scanFilesIsolated(root, paths, undefined, "repository", options);
  const changedFileScanMs = performance.now() - changedStarted;
  if (changed.completeness?.status !== "complete" || changed.scannedFiles.length !== paths.length || isolatedScanMetrics()?.cacheHit) {
    throw new Error("benchmark changed-file scan failed invalidation or completeness invariants");
  }

  const largePaths: string[] = [];
  mkdirSync(path.join(largeRoot, "src"));
  for (let index = 0; index < 1_500; index += 1) {
    const filePath = `src/module-${index}.ts`;
    largePaths.push(filePath);
    writeFileSync(path.join(largeRoot, filePath), `export const value${index} = ${index};\n`);
  }
  writeFileSync(path.join(largeRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src/**/*.ts"] }));
  const largeStarted = performance.now();
  const large = await scanFilesIsolated(largeRoot, largePaths, undefined, "repository", options);
  const largeAuditMs = performance.now() - largeStarted;
  if (large.scannedFiles.length !== largePaths.length || large.completeness?.status !== "partial") {
    throw new Error("benchmark large audit failed bounded partial-result invariants");
  }
  const largeWarmStarted = performance.now();
  const largeWarm = await scanFilesIsolated(largeRoot, largePaths, undefined, "repository", options);
  const largeWarmScanMs = performance.now() - largeWarmStarted;
  if (
    largeWarm.scannedFiles.length !== largePaths.length ||
    largeWarm.completeness?.status !== "partial" ||
    !isolatedScanMetrics()?.cacheHit
  ) {
    throw new Error(`benchmark unchanged large audit failed cache or completeness invariants: ${JSON.stringify({ status: largeWarm.completeness?.status, scannedFiles: largeWarm.scannedFiles.length, metrics: isolatedScanMetrics() })}`);
  }

  const cancellationMarker = path.join(root, "provider-active");
  const cancellationWorker = path.join(root, "cancellation-worker.mjs");
  writeFileSync(cancellationWorker, `import { writeFileSync } from 'node:fs'; import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => { writeFileSync(${JSON.stringify(cancellationMarker)}, 'active'); while (true) {} });\n`);
  const cancelled = new AbortController();
  const cancellationWatcher = watch(root);
  const providerActive = once(cancellationWatcher, "change");
  const cancellationStarted = performance.now();
  const cancellation = scanFilesIsolated(root, paths, cancelled.signal, "repository", options, {
    workerUrl: pathToFileURL(cancellationWorker),
    maxOldGenerationSizeMb: 64,
  });
  await providerActive;
  cancelled.abort();
  cancellationWatcher.close();
  let cancellationContained = false;
  try {
    await cancellation;
  } catch {
    cancellationContained = true;
  }
  const cancellationMs = performance.now() - cancellationStarted;
  if (!cancellationContained || cancellationMs > 500) throw new Error("benchmark active provider cancellation was not contained");

  const oomWorker = path.join(root, "oom-worker.mjs");
  writeFileSync(oomWorker, "import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => { const values = []; while (true) values.push(new Array(1_000_000).fill(values.length)); });\n");
  const oom = await scanFilesIsolated(root, paths, undefined, "repository", options, {
    workerUrl: pathToFileURL(oomWorker),
    maxOldGenerationSizeMb: 64,
  });
  const workerOomContained = oom.completeness?.status === "abstained";
  if (!workerOomContained) throw new Error("benchmark worker OOM was not contained");
  const queryStarted = performance.now();
  const context = queryContext(root, "value39", graphStateRoot);
  const graphQueryMs = performance.now() - queryStarted;
  if (context.query !== "value39" || !context.nodes.some((node) => node.name === "value39") || context.impacts.length !== context.nodes.length) {
    throw new Error("benchmark graph query failed correctness invariants");
  }
  const memoryAfter = process.memoryUsage();
  const memoryDeltaMiB = (memoryAfter.rss - memoryBefore.rss) / (1024 * 1024);
  const heapUsedDeltaMiB = (memoryAfter.heapUsed - memoryBefore.heapUsed) / (1024 * 1024);
  const warmP50Ms = percentile(warmTimes, 0.5);
  const warmP95Ms = percentile(warmTimes, 0.95);
  const warmCpuP50Ms = percentile(warmCpuTimes, 0.5);
  const targets = {
    coldScanMs: 1_500,
    recycledColdScanMs: 1_500,
    changedFileScanMs: 1_000,
    warmScanP95Ms: 50,
    warmWorkerCpuP50Ms: 50,
    graphQueryP95Ms: 50,
    largeAuditMs: 5_000,
    largeWarmScanMs: 100,
    maxWorkerHeapUsedMiB: 64,
    maxWorkerRssMiB: 256,
    maxRssHighWaterDeltaMiB: 64,
    maxHeapUsedDeltaMiB: 32,
    activeProviderCancellationMs: 250,
    note: "Targets are directional and never override deterministic findings, completeness, or containment.",
  };
  if (coldMs > targets.coldScanMs) throw new Error("benchmark cold-scan latency regression");
  if (recycledColdScanMs > targets.recycledColdScanMs) throw new Error("benchmark recycled-process latency regression");
  if (warmP95Ms > targets.warmScanP95Ms || changedFileScanMs > targets.changedFileScanMs) throw new Error("benchmark changed-file latency regression");
  if (warmCpuP50Ms > targets.warmWorkerCpuP50Ms) throw new Error("benchmark worker CPU regression");
  if (graphQueryMs > targets.graphQueryP95Ms) throw new Error("benchmark graph-query latency regression");
  if (largeAuditMs > targets.largeAuditMs) throw new Error("benchmark large-audit latency regression");
  if (largeWarmScanMs > targets.largeWarmScanMs) throw new Error("benchmark unchanged large-audit latency regression");
  if (warmCacheHits.some((cacheHit) => !cacheHit)) throw new Error("benchmark unchanged cache-hit regression");
  if ((coldWorker?.heapUsedMiB ?? Number.POSITIVE_INFINITY) > targets.maxWorkerHeapUsedMiB) throw new Error("benchmark worker heap regression");
  if ((coldWorker?.rssMiB ?? Number.POSITIVE_INFINITY) > targets.maxWorkerRssMiB) throw new Error(`benchmark worker RSS regression: ${coldWorker?.rssMiB ?? "missing"} MiB`);
  if (memoryDeltaMiB > targets.maxRssHighWaterDeltaMiB || heapUsedDeltaMiB > targets.maxHeapUsedDeltaMiB) throw new Error("benchmark host memory regression");
  const benchmark = {
    generatedAt: new Date().toISOString(),
    runtime: evaluationRuntimeMetadata(),
    fixture: { files: paths.length, largeAuditFiles: largePaths.length, findings: cold.findings.length, graphResults: context.nodes.length },
    measurements: {
      coldScanMs: Number(coldMs.toFixed(2)),
      recycledColdScanMs: Number(recycledColdScanMs.toFixed(2)),
      changedFileScanMs: Number(changedFileScanMs.toFixed(2)),
      warmScanP50Ms: Number(warmP50Ms.toFixed(2)),
      warmScanP95Ms: Number(warmP95Ms.toFixed(2)),
      warmCacheHitRate: warmCacheHits.filter(Boolean).length / warmCacheHits.length,
      warmWorkerCpuP50Ms: Number(warmCpuP50Ms.toFixed(2)),
      coldWorkerHeapUsedMiB: Number((coldWorker?.heapUsedMiB ?? 0).toFixed(2)),
      coldWorkerRssMiB: Number((coldWorker?.rssMiB ?? 0).toFixed(2)),
      largeAuditMs: Number(largeAuditMs.toFixed(2)),
      largeWarmScanMs: Number(largeWarmScanMs.toFixed(2)),
      graphQueryMs: Number(graphQueryMs.toFixed(2)),
      rssHighWaterDeltaMiB: Number(memoryDeltaMiB.toFixed(2)),
      heapUsedDeltaMiB: Number(heapUsedDeltaMiB.toFixed(2)),
      cancellationContained,
      activeProviderCancellationMs: Number(cancellationMs.toFixed(2)),
      workerOomContained,
    },
    targets,
    hashes: evaluationInputHashes(packageRoot, path.join(packageRoot, "library", "cases.jsonl"), config),
  };
  const artifactDirectory = path.join(packageRoot, "artifacts");
  const artifactPath = path.join(artifactDirectory, "benchmark.json");
  const temporaryPath = `${artifactPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(benchmark, null, 2)}\n`);
  renameSync(temporaryPath, artifactPath);
  process.stdout.write(`${JSON.stringify(benchmark, null, 2)}\n`);
} finally {
  await resetIsolatedScanWorker();
  rmSync(root, { recursive: true, force: true });
  rmSync(graphStateRoot, { recursive: true, force: true });
  rmSync(policyStateRoot, { recursive: true, force: true });
  rmSync(largeRoot, { recursive: true, force: true });
}
