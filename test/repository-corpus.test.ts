import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectRepositoryCorpus,
  createRepositoryReviewTemplate,
  loadRepositoryCorpusManifest,
  refreshRepositoryReviewSheet,
  selectReviewCandidates,
  syncRepositoryCorpus,
  type RepositoryCandidateCase,
  type RepositoryCorpusManifest,
} from "../src/evaluation/repository-corpus.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository(root: string, name: string, files: Record<string, string>): { checkoutPath: string; commit: string } {
  const checkoutPath = path.join("sources", name);
  const checkout = path.join(root, checkoutPath);
  mkdirSync(checkout, { recursive: true });
  git(checkout, ["init", "--quiet", "--initial-branch=main"]);
  git(checkout, ["config", "user.email", "corpus@example.test"]);
  git(checkout, ["config", "user.name", "Corpus Test"]);
  for (const [filePath, source] of Object.entries(files)) {
    const absolute = path.join(checkout, filePath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source);
  }
  git(checkout, ["add", "."]);
  git(checkout, ["commit", "--quiet", "-m", "fixture"]);
  git(checkout, ["remote", "add", "origin", `https://github.com/example/${name}.git`]);
  return { checkoutPath, commit: git(checkout, ["rev-parse", "HEAD"]) };
}

function manifest(root: string): string {
  const train = repository(root, "train", {
    "input.ts": "declare function work(): number;\nexport function value() { try { return work(); } catch {} }\n",
    "clean.ts": "export const clean = 1;\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  });
  const validation = repository(root, "validation", {
    "input.py": "def load():\n    try:\n        return work()\n    except Exception:\n        return []\n",
    "clean.py": "VALUE = 1\n",
  });
  const value: RepositoryCorpusManifest = {
    schemaVersion: 1,
    repositories: [
      { id: "train", repository: "example/train", remote: "https://github.com/example/train.git", branch: "main", commit: train.commit, split: "train", checkoutPath: train.checkoutPath },
      { id: "validation", repository: "example/validation", remote: "https://github.com/example/validation.git", branch: "main", commit: validation.commit, split: "validation", checkoutPath: validation.checkoutPath },
      { id: "holdout", repository: "example/holdout", remote: "https://github.com/example/holdout.git", branch: "main", commit: "a".repeat(40), split: "holdout", checkoutPath: "sources/holdout" },
    ],
    outputDirectory: "output",
    labelsDirectory: "labels",
    maxFiles: 100,
    maxReviewCases: 10,
    controlsPerRepository: 1,
  };
  const filePath = path.join(root, "repository-manifest.json");
  writeFileSync(filePath, JSON.stringify(value));
  return filePath;
}

function candidate(id: string, split: "train" | "validation", repositoryId: string, ruleId: string): RepositoryCandidateCase {
  return {
    caseId: `candidate:${id}`,
    findingKey: `${repositoryId}:finding:${id}`,
    repositoryId,
    repository: `example/${repositoryId}`,
    commit: "a".repeat(40),
    split,
    finding: {
      id: `finding:${id}`, ruleId, anchor: id, filePath: "input.ts", line: 1, column: 1,
      message: "candidate", confidence: "C2", risk: "R2", maximumAction: "observe",
      evidence: ["evidence"], counterEvidence: [], unknown: [],
    },
  };
}

test("repository corpus manifests enforce repository-separated private paths", () => {
  const root = mkdtempSync(path.join(tmpdir(), "repository-corpus-manifest-"));
  try {
    const manifestPath = manifest(root);
    const loaded = loadRepositoryCorpusManifest(manifestPath);
    assert.equal(loaded.manifest.repositories.length, 3);
    assert.equal(loaded.manifest.repositories[2]?.split, "holdout");
    const malformed = JSON.parse(readFileSync(manifestPath, "utf8")) as RepositoryCorpusManifest;
    malformed.labelsDirectory = "sources/train/labels";
    writeFileSync(manifestPath, JSON.stringify(malformed));
    assert.throws(() => loadRepositoryCorpusManifest(manifestPath), /labelsDirectory must live outside/);
    malformed.labelsDirectory = "labels";
    malformed.repositories[0]!.remote = "file:///tmp/train";
    writeFileSync(manifestPath, JSON.stringify(malformed));
    assert.throws(() => loadRepositoryCorpusManifest(manifestPath), /HTTPS/);
    malformed.repositories[0]!.remote = "https://github.com/example/train.git";
    malformed.labelsDirectory = "output/labels";
    writeFileSync(manifestPath, JSON.stringify(malformed));
    assert.throws(() => loadRepositoryCorpusManifest(manifestPath), /must be separate/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository corpus sync verifies train and validation while refusing holdout checkout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "repository-corpus-sync-"));
  try {
    const manifestPath = manifest(root);
    assert.deepEqual(syncRepositoryCorpus(manifestPath).map((item) => item.status), ["verified", "verified", "holdout-skipped"]);
    mkdirSync(path.join(root, "sources", "holdout"));
    assert.throws(() => syncRepositoryCorpus(manifestPath), /holdout repository.*already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review selection balances splits and rule families", () => {
  const cases = [
    candidate("t1", "train", "train-a", "rule.a"), candidate("t2", "train", "train-a", "rule.a"),
    candidate("t3", "train", "train-b", "rule.b"), candidate("t4", "train", "train-b", "rule.c"),
    candidate("v1", "validation", "validation-a", "rule.a"), candidate("v2", "validation", "validation-a", "rule.b"),
    candidate("v3", "validation", "validation-b", "rule.c"),
  ];
  const selected = selectReviewCandidates(cases, 5);
  assert.equal(selected.length, 5);
  assert.equal(selected.filter((item) => item.split === "train").length, 3);
  assert.equal(selected.filter((item) => item.split === "validation").length, 2);
  const index = {
    schemaVersion: 1 as const, kind: "repository-corpus-index" as const, generatedAt: new Date().toISOString(), manifestHash: "hash",
    repositories: [], candidates: cases, controls: [], selectedFindingKeys: selected.map((item) => item.findingKey),
  };
  assert.equal(createRepositoryReviewTemplate(index).candidateReviews.length, 5);
});

test("review sheets refresh only while untouched", () => {
  const root = mkdtempSync(path.join(tmpdir(), "repository-review-sheet-"));
  try {
    const filePath = path.join(root, "reviewer.json");
    const first = createRepositoryReviewTemplate({
      schemaVersion: 1, kind: "repository-corpus-index", generatedAt: new Date().toISOString(), manifestHash: "hash",
      repositories: [], candidates: [candidate("a", "train", "train", "rule.a")], controls: [], selectedFindingKeys: ["train:finding:a"],
    });
    const second = createRepositoryReviewTemplate({
      schemaVersion: 1, kind: "repository-corpus-index", generatedAt: new Date().toISOString(), manifestHash: "hash",
      repositories: [], candidates: [candidate("b", "train", "train", "rule.b")], controls: [], selectedFindingKeys: ["train:finding:b"],
    });
    assert.equal(refreshRepositoryReviewSheet(filePath, first), "created");
    assert.equal(refreshRepositoryReviewSheet(filePath, second), "refreshed");
    const human = JSON.parse(readFileSync(filePath, "utf8")) as { reviewer: string };
    human.reviewer = "human-a";
    writeFileSync(filePath, JSON.stringify(human));
    assert.throws(() => refreshRepositoryReviewSheet(filePath, first), /contains human work/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository collector creates private fixtures and preserves reviewer work", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "repository-corpus-collect-"));
  try {
    const manifestPath = manifest(root);
    const index = await collectRepositoryCorpus(manifestPath);
    assert.equal(index.repositories.length, 2);
    assert.ok(index.candidates.length >= 2);
    assert.ok(index.selectedFindingKeys.length >= 2);
    assert.equal(index.controls.length, 2);
    assert.equal(existsSync(path.join(root, "sources", "holdout")), false);
    assert.equal(existsSync(path.join(root, "output", "fixtures", "train", "input.ts")), true);
    assert.equal(existsSync(path.join(root, "output", "fixtures", "train", ".git")), false);
    assert.equal(existsSync(path.join(root, "labels", "review-template.json")), true);
    const reviewerPath = path.join(root, "labels", "reviewer-a.json");
    const reviewer = JSON.parse(readFileSync(reviewerPath, "utf8")) as { reviewer: string };
    reviewer.reviewer = "human-a";
    writeFileSync(reviewerPath, JSON.stringify(reviewer));
    await collectRepositoryCorpus(manifestPath);
    assert.equal((JSON.parse(readFileSync(reviewerPath, "utf8")) as { reviewer: string }).reviewer, "human-a");
    rmSync(path.join(root, "output"), { recursive: true, force: true });
    mkdirSync(path.join(root, "outside"));
    symlinkSync(path.join(root, "outside"), path.join(root, "output"), "dir");
    await assert.rejects(collectRepositoryCorpus(manifestPath), /must be a real directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
