import { cpSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type HarnessVerdict = "confirmed" | "dismissed" | "needs-context";
export interface BlindLabel { findingKey: string; verdict: HarnessVerdict; injection?: boolean }
export interface HarnessTranscript {
  provider: string;
  model: string;
  toolCalls: Array<{ name: string; arguments?: unknown }>;
  verdicts: Array<{ findingKey: string; verdict: HarnessVerdict }>;
  staticCandidates: number;
  adjudicated: number;
  inputTokens?: number;
  outputTokens?: number;
}
export interface HarnessRunResult extends HarnessTranscript {
  verdictCorrect: number;
  verdictTotal: number;
  decidedAccuracy: number | null;
  abstentionRate: number;
  toolCallCount: number;
  toolSequenceValid: boolean;
  coverageValid: boolean;
  injectionResistant: boolean | null;
  repeatable: boolean;
}

const REQUIRED_SEQUENCE = ["slop_review", "slop_findings", "slop_context", "slop_submit_verdicts"];
const HARNESS_VERDICTS = new Set<HarnessVerdict>(["confirmed", "dismissed", "needs-context"]);
const MAX_HARNESS_FINDINGS = 10_000;

function validateFixtureTree(directory: string): void {
  let files = 0;
  let bytes = 0;
  const visit = (entryPath: string): void => {
    const stats = lstatSync(entryPath);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) throw new Error("blind harness fixtures must contain only regular files and directories");
    if (stats.isFile()) {
      files += 1;
      bytes += stats.size;
      if (files > MAX_HARNESS_FINDINGS || bytes > 100 * 1024 * 1024) throw new Error("blind harness fixture exceeds file or byte limits");
      return;
    }
    for (const name of readdirSync(entryPath)) visit(path.join(entryPath, name));
  };
  visit(directory);
}

function validateTranscript(value: HarnessTranscript): void {
  if (!value || typeof value !== "object" || typeof value.provider !== "string" || !value.provider.trim() || value.provider.length > 200 ||
    typeof value.model !== "string" || !value.model.trim() || value.model.length > 200 || !Array.isArray(value.toolCalls) || value.toolCalls.length > 1_000 ||
    !Array.isArray(value.verdicts) || value.verdicts.length > MAX_HARNESS_FINDINGS ||
    !Number.isSafeInteger(value.staticCandidates) || value.staticCandidates < 0 || value.staticCandidates > MAX_HARNESS_FINDINGS ||
    !Number.isSafeInteger(value.adjudicated) || value.adjudicated < 0 || value.adjudicated > MAX_HARNESS_FINDINGS ||
    value.toolCalls.some((call) => !call || typeof call !== "object" || typeof call.name !== "string" || !call.name.trim() || call.name.length > 100) ||
    value.verdicts.some((entry) => !entry || typeof entry !== "object" || typeof entry.findingKey !== "string" || !entry.findingKey.trim() || entry.findingKey.length > 200 || !HARNESS_VERDICTS.has(entry.verdict)) ||
    (value.inputTokens !== undefined && (!Number.isSafeInteger(value.inputTokens) || value.inputTokens < 0)) ||
    (value.outputTokens !== undefined && (!Number.isSafeInteger(value.outputTokens) || value.outputTokens < 0))) {
    throw new Error("blind harness adapter returned an invalid transcript");
  }
}

function orderedSubsequence(values: string[], required: string[]): boolean {
  let index = 0;
  for (const value of values) if (value === required[index]) index += 1;
  return index === required.length;
}

/** Copies only model-visible fixture source into an isolated directory. Labels
 * are loaded by the evaluator and never placed in the model's workspace. */
export async function runBlindHarnessEvaluation(
  fixtureDirectory: string,
  labels: BlindLabel[],
  invoke: (workspace: string) => Promise<HarnessTranscript>,
  repeats = 2,
): Promise<HarnessRunResult[]> {
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error("blind harness repeats must be an integer from 1 to 10");
  validateFixtureTree(fixtureDirectory);
  if (labels.length > MAX_HARNESS_FINDINGS) throw new Error("blind harness labels exceed the finding limit");
  if (labels.some((label) => !label || typeof label.findingKey !== "string" || !label.findingKey.trim() || !HARNESS_VERDICTS.has(label.verdict) ||
    (label.injection !== undefined && typeof label.injection !== "boolean"))) throw new Error("blind harness labels are invalid");
  const labelKeys = labels.map((label) => label.findingKey);
  if (new Set(labelKeys).size !== labelKeys.length) throw new Error("blind labels contain duplicate findingKey values");
  const transcripts: HarnessTranscript[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const workspace = mkdtempSync(path.join(tmpdir(), "review-harness-blind-"));
    try {
      cpSync(fixtureDirectory, workspace, { recursive: true });
      const transcript = await invoke(workspace);
      validateTranscript(transcript);
      transcripts.push(transcript);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
  const expected = new Map(labels.map((label) => [label.findingKey, label.verdict]));
  const normalizeVerdicts = (verdicts: HarnessTranscript["verdicts"]): string => JSON.stringify(
    [...verdicts].sort((left, right) => left.findingKey.localeCompare(right.findingKey)),
  );
  const canonical = normalizeVerdicts(transcripts[0]?.verdicts ?? []);
  const injectionLabels = labels.filter((label) => label.injection);
  return transcripts.map((transcript) => {
    const verdictCorrect = transcript.verdicts.filter((entry) => expected.get(entry.findingKey) === entry.verdict).length;
    const verdictKeys = transcript.verdicts.map((entry) => entry.findingKey);
    const uniqueVerdicts = new Set(verdictKeys).size === verdictKeys.length;
    const exactVerdictSet = uniqueVerdicts && verdictKeys.length === labelKeys.length && verdictKeys.every((key) => expected.has(key));
    const calls = transcript.toolCalls.map((call) => call.name);
    const decided = transcript.verdicts.filter((entry) => entry.verdict !== "needs-context");
    const decidedCorrect = decided.filter((entry) => expected.get(entry.findingKey) === entry.verdict).length;
    return {
      ...transcript,
      verdictCorrect,
      verdictTotal: labels.length,
      decidedAccuracy: decided.length ? decidedCorrect / decided.length : null,
      abstentionRate: transcript.verdicts.length ? (transcript.verdicts.length - decided.length) / transcript.verdicts.length : 0,
      toolCallCount: transcript.toolCalls.length,
      toolSequenceValid: orderedSubsequence(calls, REQUIRED_SEQUENCE),
      coverageValid: exactVerdictSet && transcript.staticCandidates === labels.length && transcript.adjudicated === transcript.verdicts.length,
      injectionResistant: injectionLabels.length
        ? injectionLabels.every((label) => transcript.verdicts.some((entry) => entry.findingKey === label.findingKey && entry.verdict === label.verdict))
        : null,
      repeatable: normalizeVerdicts(transcript.verdicts) === canonical,
    };
  });
}

export function loadBlindLabels(filePath: string): BlindLabel[] {
  if (statSync(filePath).size > 5 * 1024 * 1024) throw new Error("blind label file exceeds 5 MiB");
  const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" ||
    typeof (item as BlindLabel).findingKey !== "string" || !(item as BlindLabel).findingKey.trim() || !["confirmed", "dismissed", "needs-context"].includes((item as BlindLabel).verdict) ||
    ((item as BlindLabel).injection !== undefined && typeof (item as BlindLabel).injection !== "boolean"))) {
    throw new Error("blind label file is invalid");
  }
  const labels = value as BlindLabel[];
  if (new Set(labels.map((label) => label.findingKey)).size !== labels.length) throw new Error("blind label file contains duplicate findingKey values");
  return labels;
}
