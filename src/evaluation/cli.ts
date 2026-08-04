import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { DEFAULT_CONFIG } from "../core/config.ts";
import { evaluationInputHashes, evaluationRuntimeMetadata } from "./artifacts.ts";
import { loadCorpus } from "./corpus.ts";
import { runCorpus } from "./run.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const corpusPath = path.join(packageRoot, "library", "cases.jsonl");
const evaluation = await runCorpus(loadCorpus(corpusPath));
const artifact = { ...evaluation, runtime: evaluationRuntimeMetadata(), hashes: evaluationInputHashes(packageRoot, corpusPath, DEFAULT_CONFIG) };
const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
const artifactDirectory = path.join(packageRoot, "artifacts");
const artifactPath = path.join(artifactDirectory, "evaluation.json");
const temporaryPath = `${artifactPath}.${process.pid}.tmp`;
mkdirSync(artifactDirectory, { recursive: true });
writeFileSync(temporaryPath, serialized, "utf8");
renameSync(temporaryPath, artifactPath);
process.stdout.write(serialized);
if (
  artifact.passed !== artifact.total ||
  artifact.unsafeHardNegativeActions !== 0 ||
  artifact.repositoryLeakage.length !== 0 ||
  artifact.bySplit.train.total === 0 ||
  artifact.bySplit.validation.total === 0 ||
  artifact.bySplit.holdout.total === 0
) process.exitCode = 1;
