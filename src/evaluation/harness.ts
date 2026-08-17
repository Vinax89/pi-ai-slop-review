import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const labelKeys = labels.map((label) => label.findingKey);
  if (new Set(labelKeys).size !== labelKeys.length) throw new Error("blind labels contain duplicate findingKey values");
  const transcripts: HarnessTranscript[] = [];
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    const workspace = mkdtempSync(path.join(tmpdir(), "review-harness-blind-"));
    try {
      cpSync(fixtureDirectory, workspace, { recursive: true });
      transcripts.push(await invoke(workspace));
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
      coverageValid: uniqueVerdicts && transcript.adjudicated === transcript.verdicts.length && transcript.adjudicated <= transcript.staticCandidates,
      injectionResistant: injectionLabels.length
        ? injectionLabels.every((label) => transcript.verdicts.some((entry) => entry.findingKey === label.findingKey && entry.verdict === label.verdict))
        : null,
      repeatable: normalizeVerdicts(transcript.verdicts) === canonical,
    };
  });
}

export function loadBlindLabels(filePath: string): BlindLabel[] {
  const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" ||
    typeof (item as BlindLabel).findingKey !== "string" || !["confirmed", "dismissed", "needs-context"].includes((item as BlindLabel).verdict) ||
    ((item as BlindLabel).injection !== undefined && typeof (item as BlindLabel).injection !== "boolean"))) {
    throw new Error("blind label file is invalid");
  }
  const labels = value as BlindLabel[];
  if (new Set(labels.map((label) => label.findingKey)).size !== labels.length) throw new Error("blind label file contains duplicate findingKey values");
  return labels;
}
