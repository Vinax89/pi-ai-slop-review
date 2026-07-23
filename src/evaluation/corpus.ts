import { readFileSync } from "node:fs";

import type { FindingConfidence, MaximumAction, ScanResult } from "../types.ts";

export type CorpusLabel = "defect" | "waste_candidate" | "context_conflict" | "assurance_gap" | "ambiguous" | "hard_negative";

export interface CorpusCase {
  id: string;
  repository: string;
  split: "train" | "validation" | "holdout";
  rule_id: string;
  language: "typescript" | "javascript" | "python";
  label: CorpusLabel;
  source: string;
  expected_confidence?: FindingConfidence;
  expected_action: MaximumAction | "ignore";
  veto?: string;
}

export interface CorpusCaseResult {
  id: string;
  repository: string;
  passed: boolean;
  expectedAction: CorpusCase["expected_action"];
  actualAction: MaximumAction | "ignore";
  unsafeAction: boolean;
  diagnostic?: string;
}

export interface CorpusEvaluation {
  cases: CorpusCaseResult[];
  total: number;
  passed: number;
  hardNegatives: number;
  unsafeHardNegativeActions: number;
  actionablePrecision: number | null;
  abstentionRate: number;
  repositoryLeakage: string[];
  bySplit: Record<string, { total: number; passed: number; unsafeHardNegativeActions: number }>;
}

function parseCase(value: unknown, line: number): CorpusCase {
  if (!value || typeof value !== "object") throw new Error(`corpus line ${line} is not an object`);
  const candidate = value as Partial<CorpusCase>;
  const languages = new Set(["typescript", "javascript", "python"]);
  const labels = new Set(["defect", "waste_candidate", "context_conflict", "assurance_gap", "ambiguous", "hard_negative"]);
  const actions = new Set(["ignore", "observe", "propose", "delegate-safe-fix"]);
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.repository !== "string" ||
    (candidate.split !== "train" && candidate.split !== "validation" && candidate.split !== "holdout") ||
    typeof candidate.rule_id !== "string" ||
    typeof candidate.language !== "string" ||
    !languages.has(candidate.language) ||
    typeof candidate.label !== "string" ||
    !labels.has(candidate.label) ||
    typeof candidate.source !== "string" ||
    typeof candidate.expected_action !== "string" ||
    !actions.has(candidate.expected_action)
  ) {
    throw new Error(`corpus line ${line} has invalid required fields`);
  }
  return candidate as CorpusCase;
}

export function loadCorpus(filePath: string): CorpusCase[] {
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [parseCase(JSON.parse(line), index + 1)];
      } catch (error) {
        throw new Error(`${filePath}: ${(error as Error).message}`);
      }
    });
}

function actualAction(result: ScanResult, corpusCase: CorpusCase): MaximumAction | "ignore" {
  const matching = result.findings.filter((finding) => finding.ruleId === corpusCase.rule_id);
  if (!matching.length) return "ignore";
  const order: Record<MaximumAction, number> = { ignore: 0, observe: 1, propose: 2, "delegate-safe-fix": 3 };
  return matching.reduce((best, finding) => (order[finding.maximumAction] > order[best] ? finding.maximumAction : best), "ignore" as MaximumAction);
}

export async function evaluateCorpus(
  cases: CorpusCase[],
  scan: (corpusCase: CorpusCase) => Promise<ScanResult>,
): Promise<CorpusEvaluation> {
  const results: CorpusCaseResult[] = [];
  let truePositiveActions = 0;
  let falsePositiveActions = 0;
  let abstentions = 0;
  for (const corpusCase of cases) {
    try {
      const result = await scan(corpusCase);
      const action = actualAction(result, corpusCase);
      const hardNegative = corpusCase.label === "hard_negative";
      const unsafeAction = hardNegative && (action === "propose" || action === "delegate-safe-fix");
      const passed = action === corpusCase.expected_action && !unsafeAction;
      if (action === "ignore" || action === "observe") abstentions += 1;
      if (action === "propose" || action === "delegate-safe-fix") {
        if (hardNegative) falsePositiveActions += 1;
        else truePositiveActions += 1;
      }
      results.push({
        id: corpusCase.id,
        repository: corpusCase.repository,
        passed,
        expectedAction: corpusCase.expected_action,
        actualAction: action,
        unsafeAction,
      });
    } catch (error) {
      results.push({
        id: corpusCase.id,
        repository: corpusCase.repository,
        passed: false,
        expectedAction: corpusCase.expected_action,
        actualAction: "ignore",
        unsafeAction: false,
        diagnostic: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const totalActions = truePositiveActions + falsePositiveActions;
  const repositorySplits = new Map<string, Set<string>>();
  for (const corpusCase of cases) {
    repositorySplits.set(corpusCase.repository, new Set([...(repositorySplits.get(corpusCase.repository) ?? []), corpusCase.split]));
  }
  const repositoryLeakage = [...repositorySplits.entries()].filter(([, splits]) => splits.size > 1).map(([repository]) => repository).sort();
  const bySplit = Object.fromEntries(["train", "validation", "holdout"].map((split) => {
    const ids = new Set(cases.filter((item) => item.split === split).map((item) => item.id));
    const selected = results.filter((item) => ids.has(item.id));
    return [split, {
      total: selected.length,
      passed: selected.filter((item) => item.passed).length,
      unsafeHardNegativeActions: selected.filter((item) => item.unsafeAction).length,
    }];
  }));
  return {
    cases: results,
    total: results.length,
    passed: results.filter((item) => item.passed).length,
    hardNegatives: cases.filter((item) => item.label === "hard_negative").length,
    unsafeHardNegativeActions: results.filter((item) => item.unsafeAction).length,
    actionablePrecision: totalActions ? truePositiveActions / totalActions : null,
    abstentionRate: cases.length ? abstentions / cases.length : 0,
    repositoryLeakage,
    bySplit,
  };
}
