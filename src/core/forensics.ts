export type ForensicInputKind = "text" | "code";

export interface BurstinessMetrics {
  unitCount: number;
  meanLength: number;
  standardDeviation: number;
  coefficientOfVariation: number | null;
}

export interface PerplexityProxyMetrics {
  value: number | null;
  order: 2;
  method: "laplace-smoothed-document-bigram";
}

export interface LogicDensityMetrics {
  tokenCount: number;
  controlTokenRate: number;
  operatorTokenRate: number;
  declarationTokenRate: number;
}

export interface RepetitionMetrics {
  nonEmptyLineCount: number;
  repeatedLineRate: number;
  repeatedTrigramRate: number;
  boilerplateBlockCount: number;
}

export interface StylometricFingerprint {
  typeTokenRatio: number | null;
  functionWordRate: number;
  punctuationRate: number;
  topTokenShare: number;
  vector: number[];
}

export interface ArgumentDependencyMetrics {
  sectionCount: number;
  dependencyRate: number;
  meanLexicalCarryover: number;
}

export interface ClaimDensityMetrics {
  sentenceCount: number;
  assertedSentenceCount: number;
  falsifiableClaimCount: number;
  falsifiableClaimRate: number;
  jargonTokenRate: number;
}

export interface InterchangeabilityMetrics {
  sectionCount: number;
  originalTransitionCoherence: number;
  shuffledTransitionCoherence: number;
  interchangeabilityIndex: number | null;
}
export interface ProjectCalibrationSample {
  sourceHash: string;
  committedAt: string;
  logicDensity: number;
  boilerplateRate: number;
}

export interface ProjectCalibration {
  sampleCount: number;
  meanLogicDensity: number;
  meanBoilerplateRate: number;
  logicDensityDrift: number | null;
  boilerplateRateDrift: number | null;
  limitations: string[];
}

export interface ForensicMetrics {
  inputKind: ForensicInputKind;
  tokenCount: number;
  sentenceCount: number;
  burstiness: BurstinessMetrics;
  perplexityProxy: PerplexityProxyMetrics;
  logicDensity: LogicDensityMetrics;
  repetition: RepetitionMetrics;
  stylometricFingerprint: StylometricFingerprint;
  argumentDependency: ArgumentDependencyMetrics;
  claimDensity: ClaimDensityMetrics;
  interchangeability: InterchangeabilityMetrics;
  limitations: string[];
}

const FUNCTION_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were", "with",
]);
const STOP_WORDS = new Set([...FUNCTION_WORDS, "about", "after", "all", "also", "but", "could", "do", "does", "each", "how", "more", "most", "not", "only", "other", "our", "over", "same", "some", "than", "their", "there", "these", "they", "through", "under", "very", "we", "what", "when", "where", "which", "who", "why", "you"]);
const JARGON_WORDS = new Set(["actionable", "alignment", "best-practice", "cutting-edge", "ecosystem", "enable", "holistic", "innovative", "leverage", "next-generation", "optimize", "paradigm", "robust", "scalable", "seamless", "solution", "synergy", "transformative", "utilize", "world-class"]);
const ASSERTION_WORDS = new Set(["always", "causes", "can", "demonstrates", "ensures", "must", "never", "proves", "requires", "should", "will"]);
const CONTROL_WORDS = new Set(["case", "catch", "else", "finally", "for", "if", "return", "switch", "throw", "try", "while", "yield"]);
const OPERATOR_PATTERN = /(?:===|!==|=>|==|!=|<=|>=|&&|\|\||\+\+|--|[+*/%<>=!?-])/g;
const TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9_']*|\d+(?:\.\d+)?|[^\s]/g;
const WORD_PATTERN = /[A-Za-z][A-Za-z0-9_']*/g;

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values: number[], average: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function tokensFor(source: string): string[] {
  return source.match(TOKEN_PATTERN) ?? [];
}

function wordsFor(source: string): string[] {
  return (source.match(WORD_PATTERN) ?? []).map((token) => token.toLowerCase());
}

function sentenceLengths(source: string, inputKind: ForensicInputKind): number[] {
  if (inputKind === "code") {
    return source.split(/\r?\n/).map((line) => tokensFor(line).length).filter((length) => length > 0);
  }
  return source
    .split(/[.!?]+(?:\s+|$)/)
    .map((sentence) => wordsFor(sentence).length)
    .filter((length) => length > 0);
}

function perplexityProxy(tokens: string[]): number | null {
  if (tokens.length < 2) return null;
  const vocabulary = new Set(tokens).size;
  const counts = new Map<string, number>();
  const contextCounts = new Map<string, number>();
  for (let index = 1; index < tokens.length; index += 1) {
    const context = tokens[index - 1];
    const key = `${context}\u0000${tokens[index]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    contextCounts.set(context, (contextCounts.get(context) ?? 0) + 1);
  }
  let negativeLogLikelihood = 0;
  for (let index = 1; index < tokens.length; index += 1) {
    const context = tokens[index - 1];
    const key = `${context}\u0000${tokens[index]}`;
    const probability = ((counts.get(key) ?? 0) + 1) / ((contextCounts.get(context) ?? 0) + vocabulary);
    negativeLogLikelihood -= Math.log(probability);
  }
  return Math.exp(negativeLogLikelihood / (tokens.length - 1));
}
function repeatedTrigramRate(tokens: string[]): number {
  if (tokens.length < 3) return 0;
  const counts = new Map<string, number>();
  for (let index = 2; index < tokens.length; index += 1) {
    const key = `${tokens[index - 2]}\u0000${tokens[index - 1]}\u0000${tokens[index]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = [...counts.values()].reduce((sum, count) => sum + (count > 1 ? count : 0), 0);
  return repeated / (tokens.length - 2);
}

function normalizedLine(line: string): string {
  return line.toLowerCase().replace(/(['"`]).*?\1/g, "<literal>").replace(/\b\d+(?:\.\d+)?\b/g, "<number>").replace(/\s+/g, " ").trim();
}
function sectionsFor(source: string): string[] {
  return source.split(/\r?\n(?:\s*\r?\n)+/).map((section) => section.trim()).filter(Boolean);
}

function contentWords(source: string): Set<string> {
  return new Set(wordsFor(source).filter((word) => word.length > 2 && !STOP_WORDS.has(word)));
}

function lexicalOverlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

function argumentDependency(sections: string[]): ArgumentDependencyMetrics {
  if (sections.length < 2) return { sectionCount: sections.length, dependencyRate: 0, meanLexicalCarryover: 0 };
  const sectionSets = sections.map(contentWords);
  const carryovers: number[] = [];
  const priorWords = new Set<string>();
  for (let index = 0; index < sectionSets.length; index += 1) {
    if (index > 0) carryovers.push(lexicalOverlap(sectionSets[index], priorWords));
    for (const word of sectionSets[index]) priorWords.add(word);
  }
  return {
    sectionCount: sections.length,
    dependencyRate: carryovers.filter((value) => value >= 0.15).length / carryovers.length,
    meanLexicalCarryover: mean(carryovers),
  };
}

function claimDensity(source: string, sourceWords: string[]): ClaimDensityMetrics {
  const sentences = source.split(/[.!?]+(?:\s+|$)/).map((sentence) => sentence.trim()).filter(Boolean);
  const asserted = sentences.filter((sentence) => wordsFor(sentence).some((word) => ASSERTION_WORDS.has(word)));
  const falsifiable = asserted.filter((sentence) => /\d|[A-Za-z_][A-Za-z0-9_]*\(|https?:\/\/|must|requires|increases|decreases|greater|less|equal|test|verify|reproduc/i.test(sentence));
  const jargonTokens = sourceWords.filter((word) => JARGON_WORDS.has(word)).length;
  return {
    sentenceCount: sentences.length,
    assertedSentenceCount: asserted.length,
    falsifiableClaimCount: falsifiable.length,
    falsifiableClaimRate: sentences.length ? falsifiable.length / sentences.length : 0,
    jargonTokenRate: sourceWords.length ? jargonTokens / sourceWords.length : 0,
  };
}


function transitionCoherence(order: Set<string>[]): number {
  if (order.length < 2) return 0;
  return mean(order.slice(1).map((section, index) => lexicalOverlap(section, order[index])));
}

function shuffledOrder<T>(items: T[]): T[] {
  const copy = [...items];
  let state = 0x9e3779b9;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const target = state % (index + 1);
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function interchangeability(sections: string[]): InterchangeabilityMetrics {
  if (sections.length < 2) return { sectionCount: sections.length, originalTransitionCoherence: 0, shuffledTransitionCoherence: 0, interchangeabilityIndex: null };
  const sectionSets = sections.map(contentWords);
  const original = transitionCoherence(sectionSets);
  const shuffled = mean(Array.from({ length: Math.min(8, sections.length + 2) }, () => transitionCoherence(shuffledOrder(sectionSets))));
  return {
    sectionCount: sections.length,
    originalTransitionCoherence: original,
    shuffledTransitionCoherence: shuffled,
    interchangeabilityIndex: original > 0 ? Math.min(1, shuffled / original) : null,
  };
}

export function analyzeForensics(source: string, inputKind: ForensicInputKind = "text"): ForensicMetrics {
  const tokens = tokensFor(source);
  const words = wordsFor(source);
  const units = sentenceLengths(source, inputKind);
  const sections = sectionsFor(source);
  const dependency = argumentDependency(sections);
  const claims = claimDensity(source, words);
  const sectionOrder = interchangeability(sections);
  const unitMean = mean(units);
  const unitDeviation = standardDeviation(units, unitMean);
  const nonEmptyLines = source.split(/\r?\n/).map((line) => normalizedLine(line)).filter(Boolean);
  const lineCounts = new Map<string, number>();
  for (const line of nonEmptyLines) lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
  const repeatedLineCount = [...lineCounts.values()].reduce((sum, count) => sum + (count > 1 ? count : 0), 0);
  const duplicateBlocks = [...lineCounts.values()].filter((count) => count > 1).length;
  const controlTokens = tokens.filter((token) => CONTROL_WORDS.has(token.toLowerCase())).length;
  const operatorTokens = (source.match(OPERATOR_PATTERN) ?? []).length;
  const declarationTokens = (source.match(/\b(?:class|const|def|enum|export|function|interface|let|struct|type|var)\b/g) ?? []).length;
  const tokenCounts = new Map<string, number>();
  for (const word of words) tokenCounts.set(word, (tokenCounts.get(word) ?? 0) + 1);
  const mostCommonTokenCount = Math.max(0, ...tokenCounts.values());
  const functionWordCount = words.filter((word) => FUNCTION_WORDS.has(word)).length;
  const punctuationCount = (source.match(/[.,;:!?()[\]{}]/g) ?? []).length;
  const typeTokenRatio = words.length ? new Set(words).size / words.length : null;
  const functionWordRate = words.length ? functionWordCount / words.length : 0;
  const punctuationRate = tokens.length ? punctuationCount / tokens.length : 0;
  const topTokenShare = words.length ? mostCommonTokenCount / words.length : 0;
  const vector = [
    typeTokenRatio ?? 0,
    functionWordRate,
    punctuationRate,
    topTokenShare,
    unitMean,
    unitDeviation,
  ];
  return {
    inputKind,
    tokenCount: tokens.length,
    sentenceCount: units.length,
    burstiness: {
      unitCount: units.length,
      meanLength: unitMean,
      standardDeviation: unitDeviation,
      coefficientOfVariation: unitMean ? unitDeviation / unitMean : null,
    },
    perplexityProxy: {
      value: perplexityProxy(tokens.map((token) => token.toLowerCase())),
      order: 2,
      method: "laplace-smoothed-document-bigram",
    },
    logicDensity: {
      tokenCount: tokens.length,
      controlTokenRate: tokens.length ? controlTokens / tokens.length : 0,
      operatorTokenRate: tokens.length ? operatorTokens / tokens.length : 0,
      declarationTokenRate: tokens.length ? declarationTokens / tokens.length : 0,
    },
    repetition: {
      nonEmptyLineCount: nonEmptyLines.length,
      repeatedLineRate: nonEmptyLines.length ? repeatedLineCount / nonEmptyLines.length : 0,
      repeatedTrigramRate: repeatedTrigramRate(words),
      boilerplateBlockCount: duplicateBlocks,
    },
    stylometricFingerprint: {
      typeTokenRatio,
      functionWordRate,
      punctuationRate,
      topTokenShare,
      vector,
    },
    argumentDependency: dependency,
    claimDensity: claims,
    interchangeability: sectionOrder,
    limitations: [
      "The perplexity value is a model-free document-bigram proxy, not a calibrated language-model perplexity score.",
      "Burstiness is descriptive and does not distinguish human authorship from deliberate style or generated text.",
      "Argument dependency and interchangeability use lexical section continuity; they are not formal discourse-logic proofs.",
      "Falsifiable-claim and jargon rates use bounded lexical heuristics and require task-specific review.",
      "Stylometric features are local fingerprints; comparison requires a separately versioned reference corpus and cannot prove provenance.",
      "Metrics do not verify factuality, relevance, authorship, C2PA provenance, SynthID watermarks, or coordinated publishing behavior.",
    ],
  };
}

export function calibrateProjectSignals(samples: ProjectCalibrationSample[]): ProjectCalibration {
  const valid = samples.filter((sample) =>
    typeof sample.sourceHash === "string" &&
    typeof sample.committedAt === "string" &&
    Number.isFinite(sample.logicDensity) &&
    Number.isFinite(sample.boilerplateRate),
  );
  const meanLogicDensity = valid.length ? mean(valid.map((sample) => sample.logicDensity)) : 0;
  const meanBoilerplateRate = valid.length ? mean(valid.map((sample) => sample.boilerplateRate)) : 0;
  const first = valid[0];
  const last = valid.at(-1);
  return {
    sampleCount: valid.length,
    meanLogicDensity,
    meanBoilerplateRate,
    logicDensityDrift: first && last ? last.logicDensity - first.logicDensity : null,
    boilerplateRateDrift: first && last ? last.boilerplateRate - first.boilerplateRate : null,
    limitations: [
      "Calibration is descriptive only and depends on caller-supplied, source-hash-linked history.",
      "This API does not read Git history, infer authorship, or label a commit as automated.",
      "Use repository policy and human review before interpreting abrupt density or boilerplate changes.",
    ],
  };
}
