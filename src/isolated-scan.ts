import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { Worker, isMainThread, parentPort } from "node:worker_threads";

import { canonicalFilePath, canonicalJson, contentHashOnce, createScanResult, isScanResult, withFileHashCache } from "./core/schema.ts";
import type { FederationOptions } from "./providers/federation.ts";
import { scanFilesWithProjects } from "./scan.ts";
import type { TypeScriptProjectContext } from "./typescript-scanner.ts";
import type { ScanResult, ScanScope } from "./types.ts";

type IsolatedScanOptions = Omit<FederationOptions, "graphSkipReason" | "typescriptProjects">;

interface ScanRequest {
  rootDir: string;
  inputPaths: string[];
  mode: ScanScope["mode"];
  options: IsolatedScanOptions;
}

interface WorkerMetrics {
  cacheHit: boolean;
  programsReused: number;
  cpuMs: number;
  heapUsedMiB: number;
  rssMiB: number;
}

interface ScanMessage {
  type: "scan";
  id: number;
  request: ScanRequest;
}

interface ScanResponse {
  id: number;
  result?: unknown;
  error?: string;
  metrics?: WorkerMetrics;
}

type AttemptOutcome =
  | { kind: "success"; result: ScanResult }
  | { kind: "scanner-failure" }
  | { kind: "infrastructure-failure"; retryable: boolean }
  | { kind: "budget" };

export interface IsolatedRuntimeOptions {
  workerUrl?: URL;
  maxOldGenerationSizeMb?: number;
  maxJobs?: number;
  maxHeapUsedMb?: number;
  maxRssMb?: number;
  timeoutMs?: number;
}

class ScanTransport {
  private readonly worker?: Worker;
  private readonly child?: ChildProcess;
  private readonly childExitListeners = new Map<(code: number) => void, (code: number | null) => void>();

  constructor(runtime: IsolatedRuntimeOptions) {
    if (runtime.workerUrl) {
      this.worker = new Worker(runtime.workerUrl, {
        execArgv: ["--experimental-strip-types", "--experimental-transform-types"],
        resourceLimits: {
          maxOldGenerationSizeMb: runtime.maxOldGenerationSizeMb ?? DEFAULT_OLD_GENERATION_MB,
          maxYoungGenerationSizeMb: 64,
        },
      });
      return;
    }
    const entry = import.meta.url.endsWith(".ts") && import.meta.url.includes("/node_modules/")
      ? new URL("../dist/src/isolated-scan.js", import.meta.url)
      : new URL(import.meta.url);
    this.child = fork(fileURLToPath(entry), [], {
      env: {
        ...process.env,
        NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(homedir(), ".cache"), "pi-ai-slop-review", "compile-cache"),
        PI_AI_SLOP_SCAN_CHILD: "1",
      },
      execArgv: [
        "--experimental-strip-types",
        "--expose-gc",
        "--experimental-transform-types",
        "--max-semi-space-size=2",
        "--optimize-for-size",
        `--max-old-space-size=${runtime.maxOldGenerationSizeMb ?? DEFAULT_OLD_GENERATION_MB}`,
      ],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
  }

  ref(): void { this.worker?.ref(); this.child?.ref(); }
  unref(): void { this.worker?.unref(); this.child?.unref(); }
  onMessage(listener: (value: unknown) => void): void { this.worker?.on("message", listener); this.child?.on("message", listener); }
  offMessage(listener: (value: unknown) => void): void { this.worker?.off("message", listener); this.child?.off("message", listener); }
  onceError(listener: (error: Error & { code?: string }) => void): void { this.worker?.once("error", listener); this.child?.once("error", listener); }
  offError(listener: (error: Error & { code?: string }) => void): void { this.worker?.off("error", listener); this.child?.off("error", listener); }
  onceExit(listener: (code: number) => void): void {
    if (this.worker) this.worker.once("exit", listener);
    if (this.child) {
      const wrapped = (code: number | null): void => listener(code ?? 1);
      this.childExitListeners.set(listener, wrapped);
      this.child.once("exit", wrapped);
    }
  }
  offExit(listener: (code: number) => void): void {
    this.worker?.off("exit", listener);
    const wrapped = this.childExitListeners.get(listener);
    if (wrapped) this.child?.off("exit", wrapped);
    this.childExitListeners.delete(listener);
  }
  postMessage(message: ScanMessage): void {
    if (this.worker) this.worker.postMessage(message);
    else this.child?.send(message);
  }
  async terminate(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      return;
    }
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.ref();
    const exited = new Promise<void>((resolve) => this.child?.once("exit", () => resolve()));
    this.child.kill();
    await exited;
  }
}

interface WorkerSession {
  worker: ScanTransport;
  key: string;
  jobs: number;
}

const DEFAULT_OLD_GENERATION_MB = 384;
const GC_HEAP_PRESSURE_BYTES = Math.min(96 * 1024 * 1024, getHeapStatistics().heap_size_limit / 2);
const DEFAULT_MAX_JOBS = 20;
const DEFAULT_MAX_HEAP_MB = 128;
const DEFAULT_MAX_RSS_MB = 384;
let session: WorkerSession | undefined;
let nextRequestId = 1;
let queue = Promise.resolve();
let lastMetrics: WorkerMetrics | undefined;
let stopping: Promise<void> | undefined;

function failedScan(request: ScanRequest, diagnostic = "isolated scan worker failed or exceeded its resource budget"): ScanResult {
  return createScanResult({
    engine: "provider-federation",
    engineVersion: "1",
    rootDir: request.rootDir,
    mode: request.mode,
    providerId: "scan-worker",
    providerVersion: "1",
    providers: [{ id: "scan-worker", version: "1", capabilities: [], status: "failed", diagnostic }],
    scannedFiles: [],
    findings: [],
    skipped: [{ filePath: "<scan-worker>", reason: diagnostic, providerId: "scan-worker" }],
  });
}

function workerKey(runtime: IsolatedRuntimeOptions): string {
  return `${runtime.workerUrl?.href ?? "default"}:${runtime.maxOldGenerationSizeMb ?? DEFAULT_OLD_GENERATION_MB}`;
}

function startWorker(runtime: IsolatedRuntimeOptions): WorkerSession {
  const worker = new ScanTransport(runtime);
  const created = { worker, key: workerKey(runtime), jobs: 0 };
  worker.onceError(() => {
    if (session?.worker === worker) session = undefined;
  });
  worker.onceExit(() => {
    if (session?.worker === worker) session = undefined;
  });
  return created;
}

async function workerFor(runtime: IsolatedRuntimeOptions): Promise<WorkerSession> {
  await stopping;
  const key = workerKey(runtime);
  if (session?.key === key) return session;
  if (session) await stopWorker(session);
  session = startWorker(runtime);
  return session;
}

function shouldRecycle(active: WorkerSession, metrics: WorkerMetrics | undefined, runtime: IsolatedRuntimeOptions): boolean {
  return active.jobs >= (runtime.maxJobs ?? DEFAULT_MAX_JOBS)
    || (metrics?.heapUsedMiB ?? 0) >= (runtime.maxHeapUsedMb ?? DEFAULT_MAX_HEAP_MB)
    || (metrics?.rssMiB ?? 0) >= (runtime.maxRssMb ?? DEFAULT_MAX_RSS_MB);
}

async function stopWorker(active: WorkerSession): Promise<void> {
  if (session?.worker === active.worker) session = undefined;
  const termination = active.worker.terminate();
  stopping = termination;
  try {
    await termination;
  } finally {
    if (stopping === termination) stopping = undefined;
  }
}

export async function resetIsolatedScanWorker(): Promise<void> {
  const active = session;
  lastMetrics = undefined;
  if (active) await stopWorker(active);
  else await stopping;
}

export function isolatedScanMetrics(): WorkerMetrics | undefined {
  return lastMetrics ? { ...lastMetrics } : undefined;
}

async function runAttempt(
  request: ScanRequest,
  signal: AbortSignal | undefined,
  runtime: IsolatedRuntimeOptions,
): Promise<AttemptOutcome> {
  const active = await workerFor(runtime);
  if (signal?.aborted) throw new Error("AI-slop review cancelled");
  active.worker.ref();
  const id = nextRequestId++;
  const { promise, resolve, reject } = Promise.withResolvers<AttemptOutcome>();
  const timeoutMs = runtime.timeoutMs ?? request.options.config?.limits.commandTimeoutMs ?? 120_000;
  let settled = false;
  const cleanup = (): void => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    active.worker.offMessage(message);
    active.worker.offError(error);
    active.worker.offExit(exit);
  };
  const finish = (outcome: AttemptOutcome): void => {
    if (settled) return;
    settled = true;
    cleanup();
    active.worker.unref();
    resolve(outcome);
  };
  const abort = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    void stopWorker(active);
    reject(new Error("AI-slop review cancelled"));
  };
  const message = (value: unknown): void => {
    if (!value || typeof value !== "object" || !("id" in value) || value.id !== id) return;
    const response = value as ScanResponse;
    if (response.metrics) lastMetrics = response.metrics;
    active.jobs += 1;
    if (response.result && isScanResult(response.result)) {
      finish({ kind: "success", result: response.result });
      if (shouldRecycle(active, response.metrics, runtime)) void stopWorker(active);
    } else finish({ kind: "scanner-failure" });
  };
  const error = (failure: Error & { code?: string }): void => {
    void stopWorker(active);
    finish({ kind: "infrastructure-failure", retryable: failure.code !== "ERR_WORKER_OUT_OF_MEMORY" });
  };
  const exit = (code: number): void => {
    if (code !== 0) finish({ kind: "infrastructure-failure", retryable: true });
  };
  const timer = setTimeout(() => {
    void stopWorker(active);
    finish({ kind: "budget" });
  }, timeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  active.worker.onMessage(message);
  active.worker.onceError(error);
  active.worker.onceExit(exit);
  active.worker.postMessage({ type: "scan", id, request } satisfies ScanMessage);
  return promise;
}

async function runIsolated(
  request: ScanRequest,
  signal: AbortSignal | undefined,
  runtime: IsolatedRuntimeOptions,
): Promise<ScanResult> {
  if (signal?.aborted) throw new Error("AI-slop review cancelled");
  const first = await runAttempt(request, signal, runtime);
  if (first.kind === "success") return first.result;
  if (first.kind === "budget") return failedScan(request, "isolated scan worker exceeded its time or CPU budget");
  if (first.kind === "scanner-failure" || !first.retryable) return failedScan(request);
  const second = await runAttempt(request, signal, runtime);
  return second.kind === "success" ? second.result : failedScan(request);
}

export function scanFilesIsolated(
  rootDir: string,
  inputPaths: string[],
  signal?: AbortSignal,
  mode: ScanScope["mode"] = "explicit",
  options: IsolatedScanOptions = {},
  runtime: IsolatedRuntimeOptions = {},
): Promise<ScanResult> {
  const request: ScanRequest = {
    rootDir,
    inputPaths,
    mode,
    options: {
      ...options,
      memoryBudgetBytes: (runtime.maxOldGenerationSizeMb ?? DEFAULT_OLD_GENERATION_MB) * 1024 * 1024,
    },
  };
  const run = (): Promise<ScanResult> => runIsolated(request, signal, runtime);
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function requestConfigurationFiles(rootDir: string, inputPaths: string[]): string[] {
  const root = realpathSync(rootDir);
  const configurations = new Set<string>();
  for (const rawPath of inputPaths) {
    let directory = path.dirname(path.resolve(root, canonicalFilePath(root, rawPath)));
    while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const candidate = path.join(directory, name);
        if (existsSync(candidate)) configurations.add(candidate);
      }
      if (directory === root) break;
      directory = path.dirname(directory);
    }
  }
  return [...configurations].sort();
}

function requestCacheKey(request: ScanRequest): string {
  const root = realpathSync(request.rootDir);
  const paths = [...new Set(request.inputPaths.map((filePath) => canonicalFilePath(root, filePath)))].sort();
  const digest = createHash("sha256");
  digest.update(canonicalJson({
    root,
    mode: request.mode,
    config: request.options.config,
    configHash: request.options.configHash,
    trustedProject: request.options.trustedProject,
    graphStateRoot: request.options.graphStateRoot,
    policyStateRoot: request.options.policyStateRoot,
    python: process.env.PI_AI_SLOP_PYTHON,
  }));
  for (const filePath of paths) {
    const absolute = path.resolve(root, filePath);
    let hash: string | null = null;
    try {
      hash = contentHashOnce(absolute);
    } catch {
      // Missing inputs remain part of the cache identity.
    }
    digest.update(filePath).update("\0").update(hash ?? "-").update("\0");
  }
  for (const filePath of requestConfigurationFiles(root, paths)) {
    digest.update(filePath).update("\0").update(contentHashOnce(filePath)).update("\0");
  }
  return digest.digest("hex");
}

if (!isMainThread || process.env.PI_AI_SLOP_SCAN_CHILD === "1") {
  let cachedKey: string | undefined;
  let cachedResult: ScanResult | undefined;
  let previousProjects: TypeScriptProjectContext[] = [];
  const sendResponse = (response: ScanResponse): void => {
    if (isMainThread) process.send?.(response);
    else parentPort?.postMessage(response);
  };
  const handleMessage = (value: unknown): void => {
    if (!value || typeof value !== "object" || !("type" in value)) return;
    if (value.type === "cancel") return;
    if (value.type !== "scan" || !("id" in value) || typeof value.id !== "number" || !("request" in value)) return;
    const message = value as ScanMessage;
    const cpuStarted = process.cpuUsage();
    void withFileHashCache(async () => {
      const key = requestCacheKey(message.request);
      const cached = cachedKey === key ? cachedResult : undefined;
      const cacheHit = cached !== undefined;
      let result: ScanResult;
      let programsReused = previousProjects.length;
      if (cached) {
        result = { ...cached, generatedAt: new Date().toISOString() };
      } else {
        const execution = await scanFilesWithProjects(message.request.rootDir, message.request.inputPaths, undefined, message.request.mode, {
          ...message.request.options,
          typescriptProjects: previousProjects,
        });
        result = execution.result;
        previousProjects = execution.projects;
        programsReused = execution.projects.filter((project) => project.reusedProgram).length;
      }
      if (!cacheHit) {
        cachedKey = key;
        cachedResult = result;
      }
      let memory = process.memoryUsage();
      if (memory.heapUsed > GC_HEAP_PRESSURE_BYTES && global.gc) {
        global.gc();
        memory = process.memoryUsage();
      }
      const cpu = process.cpuUsage(cpuStarted);
      sendResponse({
        id: message.id,
        result,
        metrics: {
          cacheHit,
          cpuMs: (cpu.user + cpu.system) / 1000,
          programsReused,
          heapUsedMiB: memory.heapUsed / (1024 * 1024),
          rssMiB: memory.rss / (1024 * 1024),
        },
      });
    }).catch(() => sendResponse({ id: message.id, error: "scan failed" }));
  };
  if (isMainThread) process.on("message", handleMessage);
  else parentPort?.on("message", handleMessage);
}
