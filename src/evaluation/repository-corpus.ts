import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { DEFAULT_CONFIG } from "../core/config.ts";
import { discoverRepositoryFiles, MANIFESTS, SOURCE_EXTENSIONS } from "../core/discovery.ts";
import { canonicalJson, contentHashOnce, sha256 } from "../core/schema.ts";
import { resetIsolatedScanWorker, scanFilesIsolated } from "../isolated-scan.ts";
import type { Finding, ScanCompleteness } from "../types.ts";

export type RepositoryCorpusSplit = "train" | "validation" | "holdout";

export interface RepositoryCorpusEntry {
  id: string;
  repository: string;
  remote: string;
  branch: string;
  commit: string;
  split: RepositoryCorpusSplit;
  checkoutPath: string;
}

export interface RepositoryCorpusManifest {
  schemaVersion: 1;
  repositories: RepositoryCorpusEntry[];
  outputDirectory: string;
  labelsDirectory: string;
  maxFiles: number;
  maxReviewCases: number;
  controlsPerRepository: number;
}

export interface RepositoryCandidateCase {
  caseId: string;
  findingKey: string;
  repositoryId: string;
  repository: string;
  commit: string;
  split: Exclude<RepositoryCorpusSplit, "holdout">;
  finding: Pick<Finding, "id" | "ruleId" | "anchor" | "filePath" | "line" | "column" | "message" | "confidence" | "risk" | "maximumAction" | "evidence" | "counterEvidence" | "unknown">;
}

export interface RepositoryControlCase {
  caseId: string;
  repositoryId: string;
  repository: string;
  commit: string;
  split: Exclude<RepositoryCorpusSplit, "holdout">;
  filePath: string;
  sourceHash: string;
}

export interface RepositoryCorpusIndex {
  schemaVersion: 1;
  kind: "repository-corpus-index";
  generatedAt: string;
  manifestHash: string;
  repositories: Array<{
    id: string;
    repository: string;
    commit: string;
    split: Exclude<RepositoryCorpusSplit, "holdout">;
    fixturePath: string;
    discovery: { files: number; truncated: boolean };
    scan: {
      scanId: string;
      status: ScanCompleteness["status"];
      scannedFiles: number;
      candidates: number;
      skipped: number;
      skippedReasons: string[];
    };
  }>;
  candidates: RepositoryCandidateCase[];
  controls: RepositoryControlCase[];
  selectedFindingKeys: string[];
}

export interface RepositoryReviewTemplate {
  schemaVersion: 1;
  reviewer: string;
  candidateReviews: Array<{
    caseId: string;
    findingKey: string;
    repositoryId: string;
    split: Exclude<RepositoryCorpusSplit, "holdout">;
    ruleId: string;
    filePath: string;
    line: number;
    message: string;
    verdict: "unreviewed" | "confirmed" | "dismissed" | "needs-context";
    rationale: string;
    evidence: string[];
  }>;
  controlReviews: Array<{
    caseId: string;
    repositoryId: string;
    filePath: string;
    verdict: "unreviewed" | "clean" | "missed-candidate";
    suspectedRuleId: string;
    rationale: string;
  }>;
}

const MANIFEST_LIMIT = 1024 * 1024;
const MAX_FIXTURE_BYTES = 100 * 1024 * 1024;
const MAX_FIXTURE_FILES = 10_000;
const AUXILIARY_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "requirements.txt", "uv.lock", "poetry.lock", "pipfile", "pipfile.lock", "setup.py", "setup.cfg", "tox.ini",
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const expected = new Set(allowed);
  return Object.keys(value).every((key) => expected.has(key));
}

function relativePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || path.isAbsolute(value)) {
    throw new Error(`${field} must be a non-empty relative path`);
  }
  const normalized = path.normalize(value);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error(`${field} escapes the private workspace`);
  return normalized;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function parseEntry(value: unknown, index: number): RepositoryCorpusEntry {
  const entry = object(value);
  const keys = ["id", "repository", "remote", "branch", "commit", "split", "checkoutPath"];
  if (!entry || !exactKeys(entry, keys) || !keys.every((key) => key in entry)) throw new Error(`repository entry ${index + 1} is invalid`);
  if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(entry.id)) throw new Error(`repository entry ${index + 1} has an invalid id`);
  if (typeof entry.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(entry.repository)) throw new Error(`repository '${entry.id}' has an invalid owner/name`);
  if (typeof entry.remote !== "string") throw new Error(`repository '${entry.id}' has an invalid remote`);
  let remote: URL;
  try { remote = new URL(entry.remote); } catch { throw new Error(`repository '${entry.id}' remote must be an HTTPS URL`); }
  if (remote.protocol !== "https:" || remote.username || remote.password) throw new Error(`repository '${entry.id}' remote must be credential-free HTTPS`);
  const remoteRepository = remote.pathname.replace(/^\//, "").replace(/\.git$/, "").toLowerCase();
  if (remote.search || remote.hash) throw new Error(`repository '${entry.id}' remote must not contain a query or fragment`);
  if (remoteRepository !== entry.repository.toLowerCase()) throw new Error(`repository '${entry.id}' remote does not match owner/name`);
  if (typeof entry.branch !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(entry.branch) || entry.branch.includes("..")) throw new Error(`repository '${entry.id}' has an invalid branch`);
  if (typeof entry.commit !== "string" || !/^[0-9a-f]{40}$/.test(entry.commit)) throw new Error(`repository '${entry.id}' must use a full lowercase commit SHA`);
  if (entry.split !== "train" && entry.split !== "validation" && entry.split !== "holdout") throw new Error(`repository '${entry.id}' has an invalid split`);
  return {
    id: entry.id,
    repository: entry.repository,
    remote: remote.toString(),
    branch: entry.branch,
    commit: entry.commit,
    split: entry.split,
    checkoutPath: relativePath(entry.checkoutPath, `repository '${entry.id}' checkoutPath`),
  };
}

export function loadRepositoryCorpusManifest(manifestPath: string): { manifest: RepositoryCorpusManifest; root: string; hash: string } {
  if (statSync(manifestPath).size > MANIFEST_LIMIT) throw new Error("repository corpus manifest exceeds 1 MiB");
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  const value = object(parsed);
  const keys = ["schemaVersion", "repositories", "outputDirectory", "labelsDirectory", "maxFiles", "maxReviewCases", "controlsPerRepository"];
  if (!value || !exactKeys(value, keys) || value.schemaVersion !== 1 || !Array.isArray(value.repositories)) throw new Error("repository corpus manifest is invalid");
  const repositories = value.repositories.map(parseEntry);
  if (repositories.length < 3 || repositories.length > 100) throw new Error("repository corpus requires 3 to 100 repositories");
  if (new Set(repositories.map((entry) => entry.id)).size !== repositories.length) throw new Error("repository corpus contains duplicate ids");
  if (new Set(repositories.map((entry) => entry.repository.toLowerCase())).size !== repositories.length) throw new Error("repository corpus contains duplicate repositories");
  if (new Set(repositories.map((entry) => entry.checkoutPath)).size !== repositories.length) throw new Error("repository corpus contains duplicate checkout paths");
  for (const split of ["train", "validation", "holdout"] as const) {
    if (!repositories.some((entry) => entry.split === split)) throw new Error(`repository corpus is missing the ${split} split`);
  }
  const root = realpathSync(path.dirname(manifestPath));
  const manifest: RepositoryCorpusManifest = {
    schemaVersion: 1,
    repositories,
    outputDirectory: relativePath(value.outputDirectory, "outputDirectory"),
    labelsDirectory: relativePath(value.labelsDirectory, "labelsDirectory"),
    maxFiles: boundedInteger(value.maxFiles, "maxFiles", 1, 10_000),
    maxReviewCases: boundedInteger(value.maxReviewCases, "maxReviewCases", 1, 500),
    controlsPerRepository: boundedInteger(value.controlsPerRepository, "controlsPerRepository", 0, 50),
  };
  const overlaps = (left: string, right: string): boolean => left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`);
  if (overlaps(manifest.outputDirectory, manifest.labelsDirectory)) throw new Error("outputDirectory and labelsDirectory must be separate");
  for (let index = 0; index < repositories.length; index += 1) {
    for (let other = index + 1; other < repositories.length; other += 1) {
      if (overlaps(repositories[index]!.checkoutPath, repositories[other]!.checkoutPath)) throw new Error("repository checkout paths must not overlap");
    }
  }
  for (const repository of repositories) {
    if (overlaps(manifest.outputDirectory, repository.checkoutPath)) {
      throw new Error("outputDirectory must live outside every repository checkout");
    }
    if (overlaps(manifest.labelsDirectory, repository.checkoutPath)) {
      throw new Error("labelsDirectory must live outside every repository checkout");
    }
  }
  return { manifest, root, hash: sha256(canonicalJson(manifest)) };
}

function contained(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  const relation = path.relative(root, absolute);
  if (relation === "" || (!relation.startsWith("..") && !path.isAbsolute(relation))) return absolute;
  throw new Error("repository corpus path escapes the private workspace");
}

function securePrivateDirectory(root: string, relative: string): string {
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (existsSync(cursor)) {
      const stats = lstatSync(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`private workspace directory '${cursor}' must be a real directory`);
    } else {
      mkdirSync(cursor, { mode: 0o700 });
    }
  }
  if (realpathSync(cursor) !== cursor) throw new Error(`private workspace directory '${cursor}' escapes through a symlink`);
  return cursor;
}

function resetGeneratedDirectory(directory: string): void {
  if (existsSync(directory)) {
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`generated directory '${directory}' must be a real directory`);
    rmSync(directory, { recursive: true, force: true });
  }
  mkdirSync(directory, { mode: 0o700 });
}

function git(checkout: string, args: string[]): string {
  return execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();
}

export function verifyRepositoryCheckout(root: string, entry: RepositoryCorpusEntry): string {
  const checkout = contained(root, entry.checkoutPath);
  const resolved = realpathSync(checkout);
  if (resolved !== checkout || lstatSync(checkout).isSymbolicLink()) throw new Error(`repository '${entry.id}' checkout must be a real directory inside the workspace`);
  const head = git(checkout, ["rev-parse", "HEAD"]);
  if (head !== entry.commit) throw new Error(`repository '${entry.id}' is at ${head || "unknown"}, expected ${entry.commit}`);
  let origin: URL;
  try { origin = new URL(git(checkout, ["remote", "get-url", "origin"])); } catch { throw new Error(`repository '${entry.id}' checkout has no valid origin`); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.toString() !== entry.remote) {
    throw new Error(`repository '${entry.id}' checkout origin does not match the manifest`);
  }
  if (git(checkout, ["status", "--porcelain"])) throw new Error(`repository '${entry.id}' checkout has modifications or untracked files`);
  return checkout;
}

export function syncRepositoryCorpus(manifestPath: string): Array<{ id: string; status: "cloned" | "verified" | "holdout-skipped" }> {
  const { manifest, root } = loadRepositoryCorpusManifest(manifestPath);
  const results: Array<{ id: string; status: "cloned" | "verified" | "holdout-skipped" }> = [];
  for (const entry of manifest.repositories) {
    const checkout = contained(root, entry.checkoutPath);
    if (entry.split === "holdout") {
      if (existsSync(checkout)) throw new Error(`holdout repository '${entry.id}' already exists in the private workspace; remove it before normal corpus work`);
      results.push({ id: entry.id, status: "holdout-skipped" });
      continue;
    }
    if (existsSync(checkout)) {
      verifyRepositoryCheckout(root, entry);
      results.push({ id: entry.id, status: "verified" });
      continue;
    }
    securePrivateDirectory(root, path.dirname(entry.checkoutPath));
    mkdirSync(checkout, { recursive: false, mode: 0o700 });
    try {
      execFileSync("git", ["-C", checkout, "init", "--quiet"], { stdio: "inherit", timeout: 120_000 });
      execFileSync("git", ["-C", checkout, "remote", "add", "origin", entry.remote], { stdio: "inherit", timeout: 120_000 });
      execFileSync("git", ["-C", checkout, "fetch", "--filter=blob:none", "--depth=1", "origin", entry.commit], {
        stdio: "inherit", timeout: 600_000,
      });
      execFileSync("git", ["-C", checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD"], { stdio: "inherit", timeout: 600_000 });
    } catch (error) {
      rmSync(checkout, { recursive: true, force: true });
      throw error;
    }
    verifyRepositoryCheckout(root, entry);
    results.push({ id: entry.id, status: "cloned" });
  }
  return results;
}

function fixtureEligible(filePath: string): boolean {
  const name = path.basename(filePath);
  const lower = name.toLowerCase();
  return SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase()) || MANIFESTS.has(name) ||
    /^(?:ts|js)config(?:\.[^.]+)?\.json$/i.test(name) || AUXILIARY_NAMES.has(lower) ||
    /^requirements[^/]*\.txt$/i.test(name);
}

function trackedFiles(checkout: string): string[] {
  return git(checkout, ["ls-files", "-z"]).split("\0").filter(Boolean).sort();
}

function stageFixture(checkout: string, destination: string): void {
  if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  let files = 0;
  let bytes = 0;
  for (const filePath of trackedFiles(checkout)) {
    if (!fixtureEligible(filePath)) continue;
    const source = path.resolve(checkout, filePath);
    const relation = path.relative(checkout, source);
    if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error("tracked fixture path escapes checkout");
    const stats = lstatSync(source);
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > 5 * 1024 * 1024) continue;
    files += 1;
    bytes += stats.size;
    if (files > MAX_FIXTURE_FILES || bytes > MAX_FIXTURE_BYTES) throw new Error("model-visible repository fixture exceeds file or byte limits");
    const target = path.resolve(destination, filePath);
    const targetRelation = path.relative(destination, target);
    if (targetRelation.startsWith("..") || path.isAbsolute(targetRelation)) throw new Error("fixture destination escapes output directory");
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
  }
}

function stableCaseId(namespace: string, value: unknown): string {
  return `${namespace}:${createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 20)}`;
}

function selectDiverse(cases: RepositoryCandidateCase[], limit: number): RepositoryCandidateCase[] {
  const remaining = [...cases].sort((left, right) => left.caseId.localeCompare(right.caseId));
  const ruleCounts = new Map<string, number>();
  const repositoryCounts = new Map<string, number>();
  const selected: RepositoryCandidateCase[] = [];
  while (remaining.length && selected.length < limit) {
    remaining.sort((left, right) => {
      const ruleDelta = (ruleCounts.get(left.finding.ruleId) ?? 0) - (ruleCounts.get(right.finding.ruleId) ?? 0);
      if (ruleDelta) return ruleDelta;
      const repositoryDelta = (repositoryCounts.get(left.repositoryId) ?? 0) - (repositoryCounts.get(right.repositoryId) ?? 0);
      return repositoryDelta || left.caseId.localeCompare(right.caseId);
    });
    const candidate = remaining.shift()!;
    selected.push(candidate);
    ruleCounts.set(candidate.finding.ruleId, (ruleCounts.get(candidate.finding.ruleId) ?? 0) + 1);
    repositoryCounts.set(candidate.repositoryId, (repositoryCounts.get(candidate.repositoryId) ?? 0) + 1);
  }
  return selected;
}

export function selectReviewCandidates(cases: RepositoryCandidateCase[], limit: number): RepositoryCandidateCase[] {
  const train = cases.filter((item) => item.split === "train");
  const validation = cases.filter((item) => item.split === "validation");
  const trainTarget = Math.min(train.length, Math.ceil(limit * 0.6));
  const validationTarget = Math.min(validation.length, limit - trainTarget);
  const selected = [...selectDiverse(train, trainTarget), ...selectDiverse(validation, validationTarget)];
  if (selected.length < limit) {
    const used = new Set(selected.map((item) => item.caseId));
    selected.push(...selectDiverse(cases.filter((item) => !used.has(item.caseId)), limit - selected.length));
  }
  return selected.slice(0, limit).sort((left, right) => left.caseId.localeCompare(right.caseId));
}

export function createRepositoryReviewTemplate(index: RepositoryCorpusIndex): RepositoryReviewTemplate {
  const selected = new Set(index.selectedFindingKeys);
  return {
    schemaVersion: 1,
    reviewer: "",
    candidateReviews: index.candidates.filter((item) => selected.has(item.findingKey)).map((item) => ({
      caseId: item.caseId,
      findingKey: item.findingKey,
      repositoryId: item.repositoryId,
      split: item.split,
      ruleId: item.finding.ruleId,
      filePath: item.finding.filePath,
      line: item.finding.line,
      message: item.finding.message,
      verdict: "unreviewed",
      rationale: "",
      evidence: [],
    })),
    controlReviews: index.controls.map((item) => ({
      caseId: item.caseId,
      repositoryId: item.repositoryId,
      filePath: item.filePath,
      verdict: "unreviewed",
      suspectedRuleId: "",
      rationale: "",
    })),
  };
}

function atomicJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, filePath);
}

function reviewCaseKeys(value: RepositoryReviewTemplate): string[] {
  return [
    ...value.candidateReviews.map((item) => `candidate:${item.caseId}:${item.findingKey}`),
    ...value.controlReviews.map((item) => `control:${item.caseId}`),
  ].sort();
}

function reviewCaseContext(value: RepositoryReviewTemplate): string {
  return canonicalJson({
    schemaVersion: value.schemaVersion,
    candidateReviews: value.candidateReviews.map(({ verdict: _verdict, rationale: _rationale, evidence: _evidence, ...item }) => item),
    controlReviews: value.controlReviews.map(({ verdict: _verdict, suspectedRuleId: _suspectedRuleId, rationale: _rationale, ...item }) => item),
  });
}

function isUntouchedReviewSheet(value: RepositoryReviewTemplate): boolean {
  return value.reviewer === "" &&
    value.candidateReviews.every((item) => item.verdict === "unreviewed" && item.rationale === "" && item.evidence.length === 0) &&
    value.controlReviews.every((item) => item.verdict === "unreviewed" && item.suspectedRuleId === "" && item.rationale === "");
}

export function refreshRepositoryReviewSheet(filePath: string, template: RepositoryReviewTemplate): "created" | "preserved" | "refreshed" {
  if (!existsSync(filePath)) {
    atomicJson(filePath, template);
    return "created";
  }
  const reviewStats = lstatSync(filePath);
  if (reviewStats.isSymbolicLink() || !reviewStats.isFile() || reviewStats.nlink !== 1) throw new Error(`review sheet '${filePath}' must be a regular private file`);
  if (reviewStats.size > 5 * 1024 * 1024) throw new Error(`review sheet '${filePath}' exceeds 5 MiB; refusing to overwrite it`);
  let current: RepositoryReviewTemplate;
  try {
    current = JSON.parse(readFileSync(filePath, "utf8")) as RepositoryReviewTemplate;
  } catch {
    throw new Error(`review sheet '${filePath}' is not valid JSON; refusing to overwrite it`);
  }
  let currentKeys: string[];
  let expectedKeys: string[];
  try {
    currentKeys = reviewCaseKeys(current);
    expectedKeys = reviewCaseKeys(template);
    if (currentKeys.length === expectedKeys.length && currentKeys.every((key, index) => key === expectedKeys[index]) && reviewCaseContext(current) === reviewCaseContext(template)) return "preserved";
  } catch {
    throw new Error(`review sheet '${filePath}' has an invalid structure; refusing to overwrite it`);
  }
  if (!isUntouchedReviewSheet(current)) {
    throw new Error(`review sheet '${filePath}' contains human work but no longer matches the selected cases`);
  }
  atomicJson(filePath, template);
  return "refreshed";
}

export async function collectRepositoryCorpus(manifestPath: string): Promise<RepositoryCorpusIndex> {
  const { manifest, root, hash } = loadRepositoryCorpusManifest(manifestPath);
  const outputRoot = securePrivateDirectory(root, manifest.outputDirectory);
  const labelsRoot = securePrivateDirectory(root, manifest.labelsDirectory);
  const fixturesRoot = path.join(outputRoot, "fixtures");
  const stateRoot = path.join(outputRoot, "state");
  const repositories: RepositoryCorpusIndex["repositories"] = [];
  const candidates: RepositoryCandidateCase[] = [];
  const controls: RepositoryControlCase[] = [];
  resetGeneratedDirectory(fixturesRoot);
  resetGeneratedDirectory(stateRoot);
  try {
    for (const entry of manifest.repositories) {
      if (entry.split === "holdout") {
        if (existsSync(contained(root, entry.checkoutPath))) throw new Error(`holdout repository '${entry.id}' must remain absent during corpus collection`);
        continue;
      }
      const checkout = verifyRepositoryCheckout(root, entry);
      const discovery = discoverRepositoryFiles(checkout, manifest.maxFiles);
      const scan = await scanFilesIsolated(checkout, discovery.paths, undefined, "repository", {
        config: { ...structuredClone(DEFAULT_CONFIG), limits: { ...DEFAULT_CONFIG.limits, maxFiles: manifest.maxFiles } },
        trustedProject: false,
        graphStateRoot: path.join(stateRoot, "graph", entry.id),
        policyStateRoot: path.join(stateRoot, "policy", entry.id),
      });
      const fixture = path.join(fixturesRoot, entry.id);
      stageFixture(checkout, fixture);
      verifyRepositoryCheckout(root, entry);
      repositories.push({
        id: entry.id,
        repository: entry.repository,
        commit: entry.commit,
        split: entry.split,
        fixturePath: path.relative(outputRoot, fixture).split(path.sep).join("/"),
        discovery: { files: discovery.paths.length, truncated: discovery.truncated },
        scan: {
          scanId: scan.scanId,
          status: discovery.truncated ? "partial" : scan.completeness?.status ?? "partial",
          scannedFiles: scan.scannedFiles.length,
          candidates: scan.findings.length,
          skipped: scan.skipped.length,
          skippedReasons: [...new Set(scan.skipped.map((item) => item.reason))].sort().slice(0, 20),
        },
      });
      for (const finding of scan.findings) {
        const findingKey = `${entry.id}:${finding.id}`;
        candidates.push({
          caseId: stableCaseId("candidate", { repository: entry.repository, commit: entry.commit, findingId: finding.id }),
          findingKey,
          repositoryId: entry.id,
          repository: entry.repository,
          commit: entry.commit,
          split: entry.split,
          finding: {
            id: finding.id, ruleId: finding.ruleId, anchor: finding.anchor, filePath: finding.filePath,
            line: finding.line, column: finding.column, message: finding.message, confidence: finding.confidence,
            risk: finding.risk, maximumAction: finding.maximumAction, evidence: finding.evidence,
            counterEvidence: finding.counterEvidence, unknown: finding.unknown,
          },
        });
      }
      const findingFiles = new Set(scan.findings.map((finding) => finding.filePath));
      const controlPaths = scan.scannedFiles
        .filter((filePath) => SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) && path.extname(filePath).toLowerCase() !== ".md" && !findingFiles.has(filePath))
        .map((filePath) => ({ filePath, order: stableCaseId("order", { repository: entry.repository, commit: entry.commit, filePath }) }))
        .sort((left, right) => left.order.localeCompare(right.order))
        .slice(0, manifest.controlsPerRepository);
      for (const { filePath } of controlPaths) {
        controls.push({
          caseId: stableCaseId("control", { repository: entry.repository, commit: entry.commit, filePath }),
          repositoryId: entry.id,
          repository: entry.repository,
          commit: entry.commit,
          split: entry.split,
          filePath,
          sourceHash: contentHashOnce(path.join(checkout, filePath)),
        });
      }
    }
  } finally {
    await resetIsolatedScanWorker();
  }
  candidates.sort((left, right) => left.caseId.localeCompare(right.caseId));
  controls.sort((left, right) => left.caseId.localeCompare(right.caseId));
  const selected = selectReviewCandidates(candidates, manifest.maxReviewCases);
  const index: RepositoryCorpusIndex = {
    schemaVersion: 1,
    kind: "repository-corpus-index",
    generatedAt: new Date().toISOString(),
    manifestHash: hash,
    repositories,
    candidates,
    controls,
    selectedFindingKeys: selected.map((item) => item.findingKey),
  };
  atomicJson(path.join(outputRoot, "repository-index.json"), index);
  atomicJson(path.join(outputRoot, "cases.json"), {
    schemaVersion: 1,
    cases: selected.map((item) => ({ caseId: item.caseId, findingKey: item.findingKey, repositoryId: item.repositoryId })),
  });
  const reviewTemplate = createRepositoryReviewTemplate(index);
  atomicJson(path.join(labelsRoot, "review-template.json"), reviewTemplate);
  refreshRepositoryReviewSheet(path.join(labelsRoot, "reviewer-a.json"), reviewTemplate);
  refreshRepositoryReviewSheet(path.join(labelsRoot, "reviewer-b.json"), reviewTemplate);
  return index;
}
