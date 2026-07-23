import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadCorpus } from "./corpus.ts";
import { runCorpus } from "./run.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const corpusPath = path.join(packageRoot, "library", "cases.jsonl");
const evaluation = await runCorpus(loadCorpus(corpusPath));
const serialized = `${JSON.stringify(evaluation, null, 2)}\n`;
const artifactDirectory = path.join(packageRoot, "artifacts");
const artifactPath = path.join(artifactDirectory, "evaluation.json");
const temporaryPath = `${artifactPath}.${process.pid}.tmp`;
mkdirSync(artifactDirectory, { recursive: true });
writeFileSync(temporaryPath, serialized, "utf8");
renameSync(temporaryPath, artifactPath);
process.stdout.write(serialized);
if (
  evaluation.passed !== evaluation.total ||
  evaluation.unsafeHardNegativeActions !== 0 ||
  evaluation.repositoryLeakage.length !== 0 ||
  evaluation.bySplit.holdout.total === 0
) process.exitCode = 1;
