import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG } from "../core/config.ts";
import { queryContext } from "../graph/query.ts";
import { scanFiles } from "../scan.ts";

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)];
}

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const root = mkdtempSync(path.join(tmpdir(), "ai-slop-benchmark-"));
const graphStateRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-benchmark-graph-"));
const policyStateRoot = mkdtempSync(path.join(tmpdir(), "ai-slop-benchmark-policy-"));
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
  (globalThis as any).gc?.();
  const memoryBefore = process.memoryUsage();
  const coldStarted = performance.now();
  const cold = await scanFiles(root, paths, undefined, "repository", options);
  const coldMs = performance.now() - coldStarted;
  const warmTimes: number[] = [];
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const started = performance.now();
    await scanFiles(root, paths, undefined, "repository", options);
    warmTimes.push(performance.now() - started);
    (globalThis as any).gc?.();
  }
  const queryStarted = performance.now();
  const context = queryContext(root, "value39", graphStateRoot);
  const graphQueryMs = performance.now() - queryStarted;
  (globalThis as any).gc?.();
  const memoryAfter = process.memoryUsage();
  const memoryDeltaMiB = (memoryAfter.rss - memoryBefore.rss) / (1024 * 1024);
  const heapUsedDeltaMiB = (memoryAfter.heapUsed - memoryBefore.heapUsed) / (1024 * 1024);
  const benchmark = {
    generatedAt: new Date().toISOString(),
    runtime: process.version,
    fixture: { files: paths.length, findings: cold.findings.length, graphResults: context.nodes.length },
    measurements: {
      coldScanMs: Number(coldMs.toFixed(2)),
      warmScanP50Ms: Number(percentile(warmTimes, 0.5).toFixed(2)),
      warmScanP95Ms: Number(percentile(warmTimes, 0.95).toFixed(2)),
      graphQueryMs: Number(graphQueryMs.toFixed(2)),
      rssHighWaterDeltaMiB: Number(memoryDeltaMiB.toFixed(2)),
      heapUsedDeltaMiB: Number(heapUsedDeltaMiB.toFixed(2)),
    },
    targets: {
      changedFileWarmP95Ms: 2_000,
      graphQueryP95Ms: 250,
      note: "The scan fixture deliberately covers forty files; targets are directional and never override correctness or safety.",
    },
  };
  const artifactDirectory = path.join(packageRoot, "artifacts");
  const artifactPath = path.join(artifactDirectory, "benchmark.json");
  const temporaryPath = `${artifactPath}.${process.pid}.tmp`;
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(benchmark, null, 2)}\n`);
  renameSync(temporaryPath, artifactPath);
  process.stdout.write(`${JSON.stringify(benchmark, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(graphStateRoot, { recursive: true, force: true });
  rmSync(policyStateRoot, { recursive: true, force: true });
}
