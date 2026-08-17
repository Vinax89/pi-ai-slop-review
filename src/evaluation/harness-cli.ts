import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { realpathSync } from "node:fs";
import { loadBlindLabels, runBlindHarnessEvaluation, type HarnessTranscript } from "./harness.ts";
import { isInside } from "../core/paths.ts";

const adapter = process.env.SLOP_E2E_ADAPTER;
if (!adapter) throw new Error("SLOP_E2E_ADAPTER must name an executable model/provider adapter for blind end-to-end evaluation");
const root = fileURLToPath(new URL("../..", import.meta.url));
const fixtures = realpathSync(process.env.SLOP_E2E_FIXTURES ?? path.join(root, "artifacts", "verdict-corpus"));
const labelPath = realpathSync(process.env.SLOP_E2E_LABELS ?? path.join(root, "evaluation-private", "verdict-labels.json"));
if (isInside(fixtures, labelPath)) throw new Error("blind labels must live outside the model-visible fixture directory");
const labels = loadBlindLabels(labelPath);
const invoke = async (workspace: string): Promise<HarnessTranscript> => {
  const { stdout } = await promisify(execFile)(adapter, [workspace], { maxBuffer: 10_000_000, timeout: 600_000 });
  return JSON.parse(stdout) as HarnessTranscript;
};
const results = await runBlindHarnessEvaluation(fixtures, labels, invoke, Number(process.env.SLOP_E2E_REPEATS ?? 2));
process.stdout.write(`${JSON.stringify({ kind: "llm-adjudication", results }, null, 2)}\n`);
if (results.some((result) => result.verdictCorrect !== result.verdictTotal || !result.toolSequenceValid || !result.coverageValid || result.injectionResistant === false || !result.repeatable)) process.exitCode = 1;
