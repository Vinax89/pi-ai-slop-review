import { execFile, spawn } from "node:child_process";
import { constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, closeSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";

import type { AiSlopConfig } from "./core/config.ts";
import { isExactConfiguredCommand, restrictedRuntime } from "./core/execution.ts";
import { redactSensitive } from "./core/redaction.ts";
import { hasSymlinkPath } from "./core/paths.ts";

import { canonicalJson, fingerprint, sha256 } from "./core/schema.ts";
import { StateStore } from "./core/store.ts";
import { runExpressionExperiment } from "./experiments/expression.ts";
import { buildGraphFacts } from "./graph/build.ts";
import { assertProposalAuthority } from "./policy/engine.ts";
import { SCHEMA_VERSION, type ExperimentSpec, type FindingRisk, type LabCheck, type LabRun, type Proposal, type ScanResult } from "./types.ts";

const execFileAsync = promisify(execFile);
async function withRepositoryLock<T>(rootDir: string, operation: () => Promise<T>): Promise<T> {
  const absoluteRoot = path.resolve(rootDir);
  if (hasSymlinkPath(absoluteRoot)) throw new Error("refusing laboratory operation in a symlinked repository path");
  const lockPath = path.join(absoluteRoot, ".ai-slop-operation.lock");
  if (hasSymlinkPath(lockPath)) throw new Error("refusing a symlinked laboratory operation lock");
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("another laboratory operation is already in progress");
    throw error;
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    return await operation();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}


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
  if (hasSymlinkPath(absolute)) throw new Error(`proposal path is not a regular file: ${filePath}`);
  let fd: number;
  try {
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`proposal path is not a regular file: ${filePath}`);
    return sha256(readFileSync(fd));
  } finally {
    closeSync(fd);
  }
}

function matches(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
    return new RegExp(`^${escaped}$`).test(filePath);
  });
}

function reviewContentHash(rootDir: string, review: ScanResult): string {
  const scannedFiles = [...new Set(review.scope.paths)].sort();
  const sourceHashes = Object.fromEntries(scannedFiles.map((filePath) => [filePath, fileHash(rootDir, filePath)]));
  return sha256(canonicalJson({ scannedFiles, sourceHashes }));
}

function assertReviewAuthorityCurrent(rootDir: string, review: ScanResult, findingIds: string[]): void {
  if (!review.scanId || !review.scope.contentHash) throw new Error("latest review integrity is incomplete");
  if (reviewContentHash(rootDir, review) !== review.scope.contentHash) throw new Error("latest review content hash is stale; run a fresh review before creating a proposal");
  for (const findingId of findingIds) {
    const finding = review.findings.find((item) => item.id === findingId);
    if (finding && fileHash(rootDir, finding.filePath) !== finding.sourceHash) {
      throw new Error(`latest review is stale for ${finding.filePath}; run a fresh review before creating a proposal`);
    }
  }
}

function proposalIntegrityFingerprint(proposal: Proposal): string {
  return fingerprint("proposal", {
    schemaVersion: proposal.schemaVersion,
    fileHashes: proposal.fileHashes,
    patch: proposal.patch,
    findingIds: proposal.findingIds,
    risk: proposal.risk,
    proofObligations: proposal.proofObligations,
    commands: proposal.commands,
    deletesFiles: proposal.deletesFiles,
    criticalPaths: proposal.criticalPaths,
    experiments: proposal.experiments,
  });
}

function labRunIntegrityFingerprint(run: LabRun): string {
  return fingerprint("lab-run", {
    proposalId: run.proposalId,
    completedAt: run.completedAt,
    checks: run.checks,
    status: run.status,
    networkIsolation: run.networkIsolation,
    publicSurfaceChanged: run.publicSurfaceChanged,
    experimentResults: run.experimentResults,
    diagnostic: run.diagnostic,
  });
}

function assertProposalIntegrity(proposal: Proposal): void {
  if (proposal.id !== proposalIntegrityFingerprint(proposal)) throw new Error("proposal integrity check failed");
}

function assertLabRunIntegrity(run: LabRun, proposal: Proposal): void {
  if (run.proposalId !== proposal.id || run.createdAt !== proposal.createdAt || run.networkIsolation !== "bubblewrap" || run.id !== labRunIntegrityFingerprint(run)) {
    throw new Error("laboratory run integrity check failed");
  }
}

function findUniqueProposal(proposals: Proposal[], input: string): Proposal | undefined {
  const matches = proposals.filter((item) => item.id === input || item.id.startsWith(input));
  if (matches.length > 1) throw new Error(`proposal prefix '${input}' is ambiguous`);
  return matches[0];
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
      output: redactSensitive(`${stdout}${stderr}`.slice(-64 * 1024)),
    };
  } catch (error: unknown) {
    const details = error && typeof error === "object" ? error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown } : {};
    const output = `${details.stdout ?? ""}${details.stderr ?? ""}${details.message ?? String(error)}`.slice(-64 * 1024);
    return {
      name: redactSensitive(command.join(" ")),
      phase,
      command: command.map(redactSensitive),
      succeeded: false,
      exitCode: typeof details.code === "number" ? details.code : null,
      durationMs: Math.round(performance.now() - started),
      output: redactSensitive(output),
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
  const findingIds = [...new Set((input.findingIds ?? []).map((id) => id.trim()).filter(Boolean))];
  const store = new StateStore(rootDir, stateRoot);
  const latestReview = store.load().baselines["last-review"];
  if (!latestReview) throw new Error("proposal requires a persisted latest review");
  assertReviewAuthorityCurrent(rootDir, latestReview, findingIds);
  assertProposalAuthority(latestReview, findingIds, input.risk, parsed.paths);
  const baseCommit = (await git(rootDir, ["rev-parse", "HEAD"])).trim();
  const fileHashes = Object.fromEntries(parsed.paths.map((filePath) => [filePath, fileHash(rootDir, filePath)]));
  const criticalPaths = parsed.paths.filter((filePath) => matches(filePath, config.lab.criticalPatterns));
  const proposal: Proposal = {
    schemaVersion: SCHEMA_VERSION,
    id: proposalIntegrityFingerprint({
      schemaVersion: SCHEMA_VERSION,
      id: "",
      createdAt: "",
      baseCommit,
      patch: input.patch,
      fileHashes,
      findingIds,
      risk: input.risk,
      proofObligations: input.proofObligations,
      commands: input.commands,
      deletesFiles: parsed.deletesFiles,
      criticalPaths,
      experiments: input.experiments ?? [],
      status: "candidate",
    }),
    createdAt: new Date().toISOString(),
    baseCommit,
    patch: input.patch,
    fileHashes,
    findingIds,
    risk: input.risk,
    proofObligations: input.proofObligations,
    commands: input.commands,
    deletesFiles: parsed.deletesFiles,
    criticalPaths,
    experiments: input.experiments ?? [],
    status: "candidate",
  };
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
  const proposal = findUniqueProposal(state.proposals, proposalId);
  if (!proposal) throw new Error(`proposal '${proposalId}' was not found`);
  if (!trustedProject || !config.execution.trusted) throw new Error("laboratory validation requires Pi project trust and execution.trusted configuration");
  const currentHead = (await git(rootDir, ["rev-parse", "HEAD"])).trim();
  if (currentHead !== proposal.baseCommit) throw new Error(`proposal base commit ${proposal.baseCommit} is not the current HEAD ${currentHead}`);
  if (!existsSync("/usr/bin/bwrap")) throw new Error("required bubblewrap network isolation is unavailable");
  const workspaceParent = mkdtempSync(path.join(tmpdir(), "ai-slop-lab-"));
  const baselineWorkspace = path.join(workspaceParent, "baseline");
  const candidateWorkspace = path.join(workspaceParent, "candidate");
  const checks: LabCheck[] = [];
  let status: LabRun["status"] = "cancelled";
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
    status = signal?.aborted ? "cancelled" : "rejected";
    diagnostic = error instanceof Error ? error.message : String(error);
  } finally {
    await git(rootDir, ["worktree", "remove", "--force", baselineWorkspace]).catch(() => undefined);
    await git(rootDir, ["worktree", "remove", "--force", candidateWorkspace]).catch(() => undefined);
    rmSync(workspaceParent, { recursive: true, force: true });
  }
  const completedAt = new Date().toISOString();
  const safeChecks = checks.map((check) => ({
    ...check,
    name: redactSensitive(check.name),
    command: check.command?.map(redactSensitive),
    output: redactSensitive(check.output),
  }));
  const safeExperimentResults = experimentResults.map((experiment) => ({
    ...experiment,
    diagnostic: experiment.diagnostic === undefined ? undefined : redactSensitive(experiment.diagnostic),
  }));
  const safeDiagnostic = diagnostic === undefined ? undefined : redactSensitive(diagnostic);
  const run: LabRun = {
    schemaVersion: SCHEMA_VERSION,
    id: labRunIntegrityFingerprint({
      schemaVersion: SCHEMA_VERSION,
      id: "",
      proposalId: proposal.id,
      createdAt: proposal.createdAt,
      completedAt,
      networkIsolation: "bubblewrap",
      checks: safeChecks,
      publicSurfaceChanged,
      experimentResults: safeExperimentResults,
      status,
      diagnostic: safeDiagnostic,
    }),
    proposalId: proposal.id,
    createdAt: proposal.createdAt,
    completedAt,
    networkIsolation: "bubblewrap",
    checks: safeChecks,
    publicSurfaceChanged,
    experimentResults: safeExperimentResults,
    status,
    diagnostic: safeDiagnostic,
  };
  store.update((next) => {
    next.labRuns.push(run);
    const candidate = next.proposals.find((item) => item.id === proposal.id);
    if (candidate && status !== "cancelled") candidate.status = status === "verified" ? "verified" : "rejected";
  });
  return run;
}

function assertProposalHashes(rootDir: string, hashes: Record<string, string | null>, context: string): void {
  for (const [filePath, expectedHash] of Object.entries(hashes)) {
    if (fileHash(rootDir, filePath) !== expectedHash) throw new Error(`${context}: ${filePath}`);
  }
}

async function applyProposalUnlocked(rootDir: string, proposalId: string, stateRoot?: string): Promise<Proposal> {
  const store = new StateStore(rootDir, stateRoot);
  const state = store.load();
  const proposal = findUniqueProposal(state.proposals, proposalId);
  if (!proposal) throw new Error(`proposal '${proposalId}' was not found`);
  assertProposalHashes(rootDir, proposal.fileHashes, "source hash changed after validation");
  assertProposalIntegrity(proposal);
  const currentHead = (await git(rootDir, ["rev-parse", "HEAD"])).trim();
  if (currentHead !== proposal.baseCommit) throw new Error(`proposal base commit ${proposal.baseCommit} is not the current HEAD ${currentHead}`);
  const latestReview = state.baselines["last-review"];
  if (!latestReview) throw new Error("proposal requires a persisted latest review");
  assertReviewAuthorityCurrent(rootDir, latestReview, proposal.findingIds);
  assertProposalAuthority(latestReview, proposal.findingIds, proposal.risk, parsePatchPaths(proposal.patch).paths);
  const run = [...state.labRuns].reverse().find((item) => item.proposalId === proposal.id && item.status === "verified");
  if (!run || proposal.status !== "verified") throw new Error("proposal has no current verified laboratory run");
  assertLabRunIntegrity(run, proposal);
  if (!run.checks.length || run.checks.some((check) => !check.succeeded) || run.publicSurfaceChanged || run.experimentResults.some((experiment) => experiment.status !== "verified")) {
    throw new Error("verified laboratory run failed integrity or contains unsuccessful checks");
  }
  if (proposal.risk === "R3") throw new Error("R3 proposals cannot be applied by the extension");
  if (proposal.deletesFiles) throw new Error("file-deleting proposals cannot be applied by the extension");
  if (proposal.criticalPaths.length) throw new Error(`critical-path proposals cannot be applied by the extension: ${proposal.criticalPaths.join(", ")}`);
  assertProposalHashes(rootDir, proposal.fileHashes, "source hash changed after validation");
  await gitApply(rootDir, ["--check", "--whitespace=error-all"], proposal.patch);
  assertProposalHashes(rootDir, proposal.fileHashes, "source hash changed during apply check");
  await gitApply(rootDir, ["--whitespace=error-all"], proposal.patch);
  proposal.appliedFileHashes = Object.fromEntries(Object.keys(proposal.fileHashes).map((filePath) => [filePath, fileHash(rootDir, filePath)]));
  proposal.status = "applied";
  store.update((next) => {
    const target = next.proposals.find((item) => item.id === proposal.id);
    if (target) {
      target.status = "applied";
      target.appliedFileHashes = proposal.appliedFileHashes;
    }
  });
  return proposal;
}

export async function applyProposal(rootDir: string, proposalId: string, stateRoot?: string): Promise<Proposal> {
  return withRepositoryLock(rootDir, () => applyProposalUnlocked(rootDir, proposalId, stateRoot));
}

async function rollbackProposalUnlocked(rootDir: string, proposalId: string, stateRoot?: string): Promise<Proposal> {
  const store = new StateStore(rootDir, stateRoot);
  const state = store.load();
  const proposal = findUniqueProposal(state.proposals, proposalId);
  if (!proposal || proposal.status !== "applied") throw new Error("only an applied proposal can be rolled back");
  if (proposal) assertProposalIntegrity(proposal);
  const currentHead = (await git(rootDir, ["rev-parse", "HEAD"])).trim();
  if (currentHead !== proposal.baseCommit) throw new Error(`proposal base commit ${proposal.baseCommit} is not the current HEAD ${currentHead}`);
  if (!proposal.appliedFileHashes) throw new Error("applied proposal has no post-apply hash guard");
  assertProposalHashes(rootDir, proposal.appliedFileHashes, "applied file hash changed before rollback");
  await gitApply(rootDir, ["--reverse", "--check"], proposal.patch);
  assertProposalHashes(rootDir, proposal.appliedFileHashes, "applied file hash changed during rollback check");
  await gitApply(rootDir, ["--reverse"], proposal.patch);
  assertProposalHashes(rootDir, proposal.fileHashes, "rollback produced unexpected file hashes");
  proposal.status = "rolled-back";
  store.update((next) => {
    const target = next.proposals.find((item) => item.id === proposal.id);
    if (target) target.status = "rolled-back";
  });
  return proposal;
}

export async function rollbackProposal(rootDir: string, proposalId: string, stateRoot?: string): Promise<Proposal> {
  return withRepositoryLock(rootDir, () => rollbackProposalUnlocked(rootDir, proposalId, stateRoot));
}

export function listLaboratory(rootDir: string, stateRoot?: string): { proposals: Proposal[]; runs: LabRun[] } {
  const state = new StateStore(rootDir, stateRoot).load();
  return {
    proposals: state.proposals.map((proposal) => ({ ...proposal, commands: proposal.commands.map((command) => command.map(redactSensitive)) })),
    runs: state.labRuns.map((run) => ({
      ...run,
      checks: run.checks.map((check) => ({
        ...check,
        name: redactSensitive(check.name),
        command: check.command?.map(redactSensitive),
        output: redactSensitive(check.output),
      })),
      diagnostic: run.diagnostic === undefined ? undefined : redactSensitive(run.diagnostic),
    })),
  };
}
