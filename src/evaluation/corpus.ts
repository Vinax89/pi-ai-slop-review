import { readFileSync } from "node:fs";

import type { FindingConfidence, MaximumAction, ScanResult } from "../types.ts";

export type CorpusLabel = "defect" | "waste_candidate" | "context_conflict" | "assurance_gap" | "ambiguous" | "hard_negative";

export interface CorpusCase {
  id: string;
  repository: string;
  split: "train" | "validation" | "holdout";
  rule_id: string;
  anchor: string;
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
  language: CorpusCase["language"];
  passed: boolean;
  expectedAction: CorpusCase["expected_action"];
  actualAction: MaximumAction | "ignore";
  expectedConfidence?: FindingConfidence;
  actualConfidence: FindingConfidence | null;
  vetoMatched: boolean | null;
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
  byLanguage: Record<string, { total: number; passed: number; unsafeHardNegativeActions: number }>;
}

export interface CorpusValidationOptions {
  requireAllSplits?: boolean;
  enforceRepositoryIsolation?: boolean;
}

const CORPUS_SPLITS = ["train", "validation", "holdout"] as const;

function parseCase(value: unknown, line: number): CorpusCase {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`corpus line ${line} is not an object`);
  const candidate = value as Partial<CorpusCase>;
  const languages = new Set(["typescript", "javascript", "python"]);
  const labels = new Set(["defect", "waste_candidate", "context_conflict", "assurance_gap", "ambiguous", "hard_negative"]);
  const actions = new Set(["ignore", "observe", "propose", "delegate-safe-fix"]);
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.repository !== "string" ||
    (candidate.split !== "train" && candidate.split !== "validation" && candidate.split !== "holdout") ||
    typeof candidate.rule_id !== "string" ||
    typeof candidate.anchor !== "string" ||
    (typeof candidate.language !== "string" || !languages.has(candidate.language)) ||
    typeof candidate.label !== "string" ||
    !labels.has(candidate.label) ||
    typeof candidate.source !== "string" ||
    typeof candidate.expected_action !== "string" ||
    !actions.has(candidate.expected_action) ||
    (candidate.expected_confidence !== undefined && !["C1", "C2", "C3"].includes(candidate.expected_confidence)) ||
    (candidate.veto !== undefined && (typeof candidate.veto !== "string" || candidate.veto.trim().length === 0))
  ) {
    throw new Error(`corpus line ${line} has invalid required fields`);
  }
  return candidate as CorpusCase;
}

export function validateCorpus(cases: CorpusCase[], options: CorpusValidationOptions = {}): void {
  const ids = new Set<string>();
  for (const corpusCase of cases) {
    if (ids.has(corpusCase.id)) throw new Error(`duplicate corpus case id '${corpusCase.id}'`);
    ids.add(corpusCase.id);
  }
  const repositorySplits = new Map<string, Set<CorpusCase["split"]>>();
  for (const corpusCase of cases) {
    const splits = repositorySplits.get(corpusCase.repository) ?? new Set<CorpusCase["split"]>();
    splits.add(corpusCase.split);
    repositorySplits.set(corpusCase.repository, splits);
  }
  const repositoryLeakage = [...repositorySplits.entries()]
    .filter(([, splits]) => splits.size > 1)
    .map(([repository]) => repository)
    .sort();
  if (options.enforceRepositoryIsolation && repositoryLeakage.length) {
    throw new Error(`corpus repository appears in multiple splits: ${repositoryLeakage.join(", ")}`);
  }
  if (options.requireAllSplits) {
    const missing = CORPUS_SPLITS.filter((split) => !cases.some((corpusCase) => corpusCase.split === split));
    if (missing.length) throw new Error(`corpus is missing required split(s): ${missing.join(", ")}`);
  }
}

export function loadCorpus(filePath: string): CorpusCase[] {
  const cases = readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .flatMap((line, index) => {
      if (!line.trim()) return [];
      try {
        return [parseCase(JSON.parse(line), index + 1)];
      } catch (error) {
        throw new Error(`${filePath}: ${(error as Error).message}`);
      }
    });
  validateCorpus(cases);
  return cases;
}

function selectedFinding(result: ScanResult, corpusCase: CorpusCase): ScanResult["findings"][number] | undefined {
  const matching = result.findings.filter((finding) => finding.ruleId === corpusCase.rule_id && finding.anchor === corpusCase.anchor);
  if (!matching.length) return undefined;
  const actionOrder: Record<MaximumAction, number> = { ignore: 0, observe: 1, propose: 2, "delegate-safe-fix": 3 };
  const confidenceOrder: Record<FindingConfidence, number> = { C1: 1, C2: 2, C3: 3 };
  return matching.reduce((best, finding) => {
    const actionDelta = actionOrder[finding.maximumAction] - actionOrder[best.maximumAction];
    return actionDelta > 0 || (actionDelta === 0 && confidenceOrder[finding.confidence] > confidenceOrder[best.confidence]) ? finding : best;
  });
}

const VETO_ALIASES: Record<string, string[]> = {
  "public-api": ["exported", "public api"],
  "explicit-return-contract": ["explicit return contract"],
  overload: ["overload"],
};

function matchesVeto(finding: ScanResult["findings"][number], expectedVeto: string): boolean {
  const normalized = expectedVeto.toLowerCase().replaceAll("-", " ");
  const candidates = [normalized, ...(VETO_ALIASES[expectedVeto.toLowerCase()] ?? [])];
  return finding.counterEvidence.some((item) => {
    const evidence = item.toLowerCase();
    return candidates.some((candidate) => evidence.includes(candidate));
  });
}

export async function evaluateCorpus(
  cases: CorpusCase[],
  scan: (corpusCase: CorpusCase) => Promise<ScanResult>,
  options: CorpusValidationOptions = {},
): Promise<CorpusEvaluation> {
  validateCorpus(cases, options);
  const results: CorpusCaseResult[] = [];
  let truePositiveActions = 0;
  let falsePositiveActions = 0;
  let abstentions = 0;
  for (const corpusCase of cases) {
    try {
      const result = await scan(corpusCase);
      const finding = selectedFinding(result, corpusCase);
      const action = finding?.maximumAction ?? "ignore";
      const actualConfidence = finding?.confidence ?? null;
      const vetoMatched = corpusCase.veto === undefined ? null : finding ? matchesVeto(finding, corpusCase.veto) : false;
      const hardNegative = corpusCase.label === "hard_negative";
      const unsafeAction = hardNegative && (action === "propose" || action === "delegate-safe-fix");
      const diagnostics: string[] = [];
      if (action !== corpusCase.expected_action) diagnostics.push(`expected action ${corpusCase.expected_action}, got ${action}`);
      if (corpusCase.expected_confidence !== undefined && actualConfidence !== corpusCase.expected_confidence) {
        diagnostics.push(`expected confidence ${corpusCase.expected_confidence}, got ${actualConfidence ?? "none"}`);
      }
      if (vetoMatched === false) diagnostics.push(`expected veto '${corpusCase.veto}' was not observed in counterevidence`);
      if (unsafeAction) diagnostics.push("hard negative produced an unsafe action");
      const passed = diagnostics.length === 0;
      if (action === "ignore" || action === "observe") abstentions += 1;
      if (action === "propose" || action === "delegate-safe-fix") {
        if (hardNegative) falsePositiveActions += 1;
        else truePositiveActions += 1;
      }
      results.push({
        id: corpusCase.id,
        repository: corpusCase.repository,
        language: corpusCase.language,
        passed,
        expectedAction: corpusCase.expected_action,
        actualAction: action,
        expectedConfidence: corpusCase.expected_confidence,
        actualConfidence,
        vetoMatched,
        unsafeAction,
        diagnostic: diagnostics.length ? diagnostics.join("; ") : undefined,
      });
    } catch (error) {
      results.push({
        id: corpusCase.id,
        repository: corpusCase.repository,
        language: corpusCase.language,
        passed: false,
        expectedAction: corpusCase.expected_action,
        actualAction: "ignore",
        expectedConfidence: corpusCase.expected_confidence,
        actualConfidence: null,
        vetoMatched: corpusCase.veto === undefined ? null : false,
        unsafeAction: false,
        diagnostic: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const totalActions = truePositiveActions + falsePositiveActions;
  const repositorySplits = new Map<string, Set<CorpusCase["split"]>>();
  for (const corpusCase of cases) {
    const splits = repositorySplits.get(corpusCase.repository) ?? new Set<CorpusCase["split"]>();
    splits.add(corpusCase.split);
    repositorySplits.set(corpusCase.repository, splits);
  }
  const repositoryLeakage = [...repositorySplits.entries()].filter(([, splits]) => splits.size > 1).map(([repository]) => repository).sort();
  const bySplit = Object.fromEntries(CORPUS_SPLITS.map((split) => {
    const ids = new Set(cases.filter((item) => item.split === split).map((item) => item.id));
    const selected = results.filter((item) => ids.has(item.id));
    return [split, {
      total: selected.length,
      passed: selected.filter((item) => item.passed).length,
      unsafeHardNegativeActions: selected.filter((item) => item.unsafeAction).length,
    }];
  }));
  const byLanguage = Object.fromEntries(["typescript", "javascript", "python"].map((language) => {
    const selected = results.filter((item) => item.language === language);
    return [language, {
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
    byLanguage,
  };
}
