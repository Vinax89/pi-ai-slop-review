import { execFile, spawn } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";

import type { AiSlopConfig } from "./core/config.ts";
import { isExactConfiguredCommand, restrictedRuntime } from "./core/execution.ts";
import { canonicalJson, fingerprint, sha256 } from "./core/schema.ts";
import { StateStore } from "./core/store.ts";
import { runExpressionExperiment } from "./experiments/expression.ts";
import { buildGraphFacts } from "./graph/build.ts";
import { SCHEMA_VERSION, type ExperimentSpec, type FindingRisk, type LabCheck, type LabRun, type Proposal } from "./types.ts";

const execFileAsync = promisify(execFile);

interface PatchPaths {
  paths: string[];
  deletesFiles: boolean;
}

function parsePatchPaths(patch: string): PatchPaths {
  const paths = new Set<string>();
  let deletesFiles = false;
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (match) {
      for (const raw of [match[1], match[2]]) {
        if (raw.includes("\0") || path.isAbsolute(raw) || raw.split("/").includes("..")) throw new Error("patch contains an unsafe path");
        paths.add(raw);
      }
    }
    if (line === "+++ /dev/null") deletesFiles = true;
  }
  if (!paths.size) throw new Error("patch must contain standard 'diff --git' headers");
  if (paths.size > 100) throw new Error("patch exceeds the 100-file safety limit");
  return { paths: [...paths].sort(), deletesFiles };
}

function fileHash(rootDir: string, filePath: string): string | null {
  const absolute = path.resolve(rootDir, filePath);
  if (!existsSync(absolute)) return null;
  const stats = lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`proposal path is not a regular file: ${filePath}`);
  return sha256(readFileSync(absolute));
}

function matches(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
    return new RegExp(`^${escaped}$`).test(filePath);
  });
}

async function git(rootDir: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: rootDir, encoding: "utf8", maxBuffer, timeout: 60_000 });
  return result.stdout;
}

function gitApply(rootDir: string, args: string[], patch: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["apply", ...args, "-"], { cwd: rootDir, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error("git apply timed out"));
    }, 30_000);
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(code === 0 ? undefined : new Error(output || `git apply exited ${String(code)}`)));
    signal?.addEventListener("abort", () => {
      child.kill("SIGTERM");
      finish(new Error("git apply cancelled"));
    }, { once: true });
    child.stdin.end(patch);
  });
}

function nulPaths(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

async function overlayWorkingChanges(rootDir: string, workspace: string): Promise<void> {
  const groups = await Promise.all([
    git(rootDir, ["diff", "--name-only", "-z"]),
    git(rootDir, ["diff", "--cached", "--name-only", "-z"]),
    git(rootDir, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  for (const filePath of new Set(groups.flatMap(nulPaths))) {
    if (path.isAbsolute(filePath) || filePath.split("/").includes("..")) throw new Error("git reported an unsafe changed path");
    const source = path.join(rootDir, filePath);
    const destination = path.join(workspace, filePath);
    if (!existsSync(source)) {
      rmSync(destination, { recursive: true, force: true });
      continue;
    }
    const stats = lstatSync(source);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`cannot mirror non-regular changed path: ${filePath}`);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function dependencyMounts(rootDir: string, workspace: string, maxDepth = 4): Array<{ source: string; target: string }> {
  const mounts: Array<{ source: string; target: string }> = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: rootDir, depth: 0 }];
  while (queue.length) {
    const { directory, depth } = queue.shift()!;
    if (depth > maxDepth) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (!entry.isDirectory()) continue;
      if (["node_modules", ".venv", "venv"].includes(entry.name)) {
        const relative = path.relative(rootDir, absolute);
        const target = path.join(workspace, relative);
        mkdirSync(target, { recursive: true });
        mounts.push({ source: absolute, target });
      } else if (![".git", "dist", "build", "coverage", "vendor"].includes(entry.name)) {
        queue.push({ directory: absolute, depth: depth + 1 });
      }
    }
  }
  return mounts;
}

async function runIsolated(
  rootDir: string,
  workspace: string,
  command: string[],
  phase: LabCheck["phase"],
  config: AiSlopConfig,
  signal?: AbortSignal,
): Promise<LabCheck> {
  if (!isExactConfiguredCommand(command, config.execution.commands)) {
    return { name: "command-allowlist", phase, command, succeeded: false, durationMs: 0, output: "command is not an exact execution.commands entry" };
  }
  const started = performance.now();
  const mounts = dependencyMounts(rootDir, workspace);
  let runtime: ReturnType<typeof restrictedRuntime>;
  try {
    runtime = restrictedRuntime(command, workspace);
  } catch (error) {
    return { name: "restricted-runtime", phase, command, succeeded: false, durationMs: 0, output: error instanceof Error ? error.message : String(error) };
  }
  const args = [
    ...runtime.args,
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--dir", "/tmp/home",
    "--bind", workspace, workspace,
    ...mounts.flatMap((mount) => ["--ro-bind", mount.source, mount.target]),
    "--clearenv",
    "--setenv", "PATH", runtime.path,
    "--setenv", "HOME", "/tmp/home",
    "--setenv", "TMPDIR", "/tmp",
    "--setenv", "CI", "1",
    "--setenv", "PIP_NO_INDEX", "1",
    "--setenv", "npm_config_offline", "true",
    "--setenv", "GIT_CONFIG_NOSYSTEM", "1",
    "--chdir", workspace,
    "--",
    ...command,
  ];
  try {
    const { stdout, stderr } = await execFileAsync("bwrap", args, {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: config.limits.maxOutputBytes,
      timeout: config.limits.commandTimeoutMs,
      signal,
      env: { PATH: process.env.PATH },
    });
    return {
      name: command.join(" "),
      phase,
      command,
      succeeded: true,
      exitCode: 0,
      durationMs: Math.round(performance.now() - started),
      output: `${stdout}${stderr}`.slice(-64 * 1024),
    };
  } catch (error: any) {
    return {
      name: command.join(" "),
      phase,
      command,
      succeeded: false,
      exitCode: typeof error?.code === "number" ? error.code : null,
      durationMs: Math.round(performance.now() - started),
      output: `${error?.stdout ?? ""}${error?.stderr ?? ""}${error?.message ?? error}`.slice(-64 * 1024),
    };
  }
}

async function surface(rootDir: string, paths: string[], config: AiSlopConfig, signal?: AbortSignal): Promise<string> {
  const built = await buildGraphFacts(rootDir, paths, config, signal);
  if (Object.keys(built.errors).length) throw new Error(`surface extraction failed: ${JSON.stringify(built.errors)}`);
  return canonicalJson(
    built.facts.flatMap((facts) =>
      facts.nodes.filter((node) => node.exported).map((node) => ({ filePath: node.filePath, kind: node.kind, qualifiedName: node.qualifiedName, signature: node.signature })),
    ),
  );
}

export async function createProposal(
  rootDir: string,
  input: {
    patch: string;
    findingIds?: string[];
    risk: FindingRisk;
    proofObligations: string[];
    commands: string[][];
    experiments?: ExperimentSpec[];
  },
  config: AiSlopConfig,
  stateRoot?: string,
): Promise<Proposal> {
  if (!config.lab.enabled) throw new Error("patch laboratory is disabled");
  if (Buffer.byteLength(input.patch) > config.lab.maxPatchBytes) throw new Error(`patch exceeds ${config.lab.maxPatchBytes} bytes`);
  if (!input.proofObligations.length || input.proofObligations.some((item) => !item.trim())) throw new Error("at least one explicit proof obligation is required");
  if (!input.commands.length || input.commands.length > config.lab.maxCommands) throw new Error(`one to ${config.lab.maxCommands} validation commands are required`);
  for (const command of input.commands) {
    if (!isExactConfiguredCommand(command, config.execution.commands)) throw new Error(`command is not an exact execution.commands entry: ${command.join(" ")}`);
  }
  const parsed = parsePatchPaths(input.patch);
  const baseCommit = (await git(rootDir, ["rev-parse", "HEAD"])).trim();
  const fileHashes = Object.fromEntries(parsed.paths.map((filePath) => [filePath, fileHash(rootDir, filePath)]));
  const criticalPaths = parsed.paths.filter((filePath) => matches(filePath, config.lab.criticalPatterns));
  const proposal: Proposal = {
    schemaVersion: SCHEMA_VERSION,
    id: fingerprint("proposal", { baseCommit, fileHashes, patch: input.patch, proofObligations: input.proofObligations }),
    createdAt: new Date().toISOString(),
    baseCommit,
    patch: input.patch,
    fileHashes,
    findingIds: [...new Set(input.findingIds ?? [])],
    risk: input.risk,
    proofObligations: input.proofObligations,
    commands: input.commands,
    deletesFiles: parsed.deletesFiles,
    criticalPaths,
    experiments: input.experiments ?? [],
    status: "candidate",
  };
  const store = new StateStore(rootDir, stateRoot);
  store.update((state) => {
    state.proposals = [...state.proposals.filter((item) => item.id !== proposal.id), proposal];
  });
  return proposal;
}

export async function validateProposal(
  rootDir: string,
  proposalId: string,
  config: AiSlopConfig,
  trustedProject: boolean,
  signal?: AbortSignal,
  stateRoot?: string,
): Promise<LabRun> {
  const store = new StateStore(rootDir, stateRoot);
  const state = store.load();
  const proposal = state.proposals.find((item) => item.id === proposalId || item.id.startsWith(proposalId));
  if (!proposal) throw new Error(`proposal '${proposalId}' was not found`);
  if (!trustedProject || !config.execution.trusted) throw new Error("laboratory validation requires Pi project trust and execution.trusted configuration");
  if (!existsSync("/usr/bin/bwrap")) throw new Error("required bubblewrap network isolation is unavailable");
  const workspaceParent = mkdtempSync(path.join(tmpdir(), "ai-slop-lab-"));
  const baselineWorkspace = path.join(workspaceParent, "baseline");
  const candidateWorkspace = path.join(workspaceParent, "candidate");
  const checks: LabCheck[] = [];
  let status: LabRun["status"] = "aborted";
  let diagnostic: string | undefined;
  let publicSurfaceChanged = false;
  const experimentResults = proposal.experiments.map(runExpressionExperiment);
  try {
    await git(rootDir, ["worktree", "add", "--detach", baselineWorkspace, proposal.baseCommit]);
    await git(rootDir, ["worktree", "add", "--detach", candidateWorkspace, proposal.baseCommit]);
    await overlayWorkingChanges(rootDir, baselineWorkspace);
    await overlayWorkingChanges(rootDir, candidateWorkspace);
    const baselineSurface = await surface(baselineWorkspace, Object.keys(proposal.fileHashes), config, signal);
    for (const command of proposal.commands) checks.push(await runIsolated(rootDir, baselineWorkspace, command, "baseline", config, signal));
    if (checks.some((check) => !check.succeeded)) throw new Error("baseline validation failed; the proposal cannot claim a clean comparison");
    checks.push({
      name: "network-and-environment-isolation",
      phase: "isolation",
      succeeded: true,
      durationMs: 0,
      output: "validation commands ran through bubblewrap with a separate network namespace, clear environment, private HOME, and private /tmp",
    });
    const applyStarted = performance.now();
    try {
      await gitApply(candidateWorkspace, ["--check", "--whitespace=error-all"], proposal.patch, signal);
      await gitApply(candidateWorkspace, ["--whitespace=error-all"], proposal.patch, signal);
      checks.push({ name: "patch-apply", phase: "candidate", succeeded: true, durationMs: Math.round(performance.now() - applyStarted), output: "patch applied in isolated worktree" });
    } catch (error: any) {
      checks.push({ name: "patch-apply", phase: "candidate", succeeded: false, durationMs: Math.round(performance.now() - applyStarted), output: `${error?.stderr ?? error?.message ?? error}` });
      throw new Error("proposal patch did not apply cleanly");
    }
    for (const command of proposal.commands) checks.push(await runIsolated(rootDir, candidateWorkspace, command, "candidate", config, signal));
    const candidateSurface = await surface(candidateWorkspace, Object.keys(proposal.fileHashes), config, signal);
    publicSurfaceChanged = baselineSurface !== candidateSurface;
    checks.push({
      name: "public-surface-comparison",
      phase: "comparison",
      succeeded: !publicSurfaceChanged,
      durationMs: 0,
      output: publicSurfaceChanged ? "public surface changed" : "public surface unchanged",
    });
    for (const experiment of experimentResults) {
      checks.push({
        name: `experiment:${experiment.specId}`,
        phase: "comparison",
        succeeded: experiment.status === "verified",
        durationMs: 0,
        output: `${experiment.status}; ${experiment.cases} case(s); ${experiment.counterexamples.length} counterexample(s)${experiment.diagnostic ? `; ${experiment.diagnostic}` : ""}`,
      });
    }
    status = checks.every((check) => check.succeeded) ? "verified" : "rejected";
  } catch (error) {
    status = signal?.aborted ? "aborted" : "rejected";
    diagnostic = error instanceof Error ? error.message : String(error);
  } finally {
    await git(rootDir, ["worktree", "remove", "--force", baselineWorkspace]).catch(() => undefined);
    await git(rootDir, ["worktree", "remove", "--force", candidateWorkspace]).catch(() => undefined);
    rmSync(workspaceParent, { recursive: true, force: true });
  }
  const completedAt = new Date().toISOString();
  const run: LabRun = {
    schemaVersion: SCHEMA_VERSION,
    id: fingerprint("lab-run", { proposalId: proposal.id, completedAt, checks, status }),
    proposalId: proposal.id,
    createdAt: proposal.createdAt,
    completedAt,
    networkIsolation: "bubblewrap",
    checks,
    publicSurfaceChanged,
    experimentResults,
    status,
    diagnostic,
  };
  store.update((next) => {
    next.labRuns.push(run);
    const candidate = next.proposals.find((item) => item.id === proposal.id);
    if (candidate) candidate.status = status === "verified" ? "verified" : "rejected";
  });
  return run;
}

export async function applyProposal(rootDir: string, proposalId: string, stateRoot?: string): Promise<Proposal> {
  const store = new StateStore(rootDir, stateRoot);
  const state = store.load();
  const proposal = state.proposals.find((item) => item.id === proposalId || item.id.startsWith(proposalId));
  if (!proposal) throw new Error(`proposal '${proposalId}' was not found`);
  const run = [...state.labRuns].reverse().find((item) => item.proposalId === proposal.id && item.status === "verified");
  if (!run || proposal.status !== "verified") throw new Error("proposal has no current verified laboratory run");
  if (proposal.risk === "R3") throw new Error("R3 proposals cannot be applied by the extension");
  if (proposal.deletesFiles) throw new Error("file-deleting proposals cannot be applied by the extension");
  if (proposal.criticalPaths.length) throw new Error(`critical-path proposals cannot be applied by the extension: ${proposal.criticalPaths.join(", ")}`);
  for (const [filePath, expectedHash] of Object.entries(proposal.fileHashes)) {
    if (fileHash(rootDir, filePath) !== expectedHash) throw new Error(`source hash changed after validation: ${filePath}`);
  }
  await gitApply(rootDir, ["--check", "--whitespace=error-all"], proposal.patch);
  await gitApply(rootDir, ["--whitespace=error-all"], proposal.patch);
  proposal.status = "applied";
  store.update((next) => {
    const target = next.proposals.find((item) => item.id === proposal.id);
    if (target) target.status = "applied";
  });
  return proposal;
}

export async function rollbackProposal(rootDir: string, proposalId: string, stateRoot?: string): Promise<Proposal> {
  const store = new StateStore(rootDir, stateRoot);
  const state = store.load();
  const proposal = state.proposals.find((item) => item.id === proposalId || item.id.startsWith(proposalId));
  if (!proposal || proposal.status !== "applied") throw new Error("only an applied proposal can be rolled back");
  await gitApply(rootDir, ["--reverse", "--check"], proposal.patch);
  await gitApply(rootDir, ["--reverse"], proposal.patch);
  proposal.status = "rolled-back";
  store.update((next) => {
    const target = next.proposals.find((item) => item.id === proposal.id);
    if (target) target.status = "rolled-back";
  });
  return proposal;
}

export function listLaboratory(rootDir: string, stateRoot?: string): { proposals: Proposal[]; runs: LabRun[] } {
  const state = new StateStore(rootDir, stateRoot).load();
  return { proposals: state.proposals, runs: state.labRuns };
}
