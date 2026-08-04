import { assessScanCompleteness } from "./completeness.ts";
import type { ForensicMetrics } from "./forensics.ts";
import type {
  EvidenceRecord,
  Finding,
  FindingConfidence,
  MaximumAction,
  ScanResult,
} from "../types.ts";

export type IntentHypothesisKind =
  | "likely-defect"
  | "likely-intentional"
  | "framework-required"
  | "compatibility-boundary"
  | "duplicate-contract"
  | "generated-or-vendored"
  | "external-or-dynamic-context"
  | "suspicious-structure"
  | "insufficient-context";

export type IntentAssessmentStatus = "supported" | "contested" | "unknown";
export type IntentStepResult = "pass" | "fail" | "unknown" | "conflict";

export const INTENT_CRITERIA = [
  "A suspicious pattern is not AI-slop by itself.",
  "A likely-AI-slop determination requires complete relevant context and no unresolved counterevidence.",
  "Public boundaries, registrations, callers, tests, specifications, or coverage are evidence of possible intent, not proof of correctness.",
  "Missing static references are unknown context, not proof that code is unused.",
  "Independent provider agreement increases corroboration but provider count is not proof of intent or correctness.",
  "Generated, vendored, dynamic, and externally consumed code require explicit ownership and runtime-context review.",
  "R3 findings and contested or incomplete assessments require human review.",
] as const;
export type ReviewArtifact = "library" | "application" | "cli" | "service" | "test" | "documentation" | "unknown";
export type ReviewTask = "bug-review" | "maintenance" | "security" | "api-review" | "cleanup" | "unknown";

export interface IntentReviewProfile {
  artifact: ReviewArtifact;
  task: ReviewTask;
  audience?: string;
  expectedProperties: string[];
  toleratedPatterns: string[];
  prohibitedPatterns: string[];
}

export const DEFAULT_REVIEW_PROFILE: IntentReviewProfile = {
  artifact: "unknown",
  task: "bug-review",
  expectedProperties: [],
  toleratedPatterns: [],
  prohibitedPatterns: [],
};

export type IntentDimension = "relevance" | "factuality" | "density" | "repetition" | "templatedness" | "coherence" | "tone";
export type IntentDimensionStatus = "observed" | "unknown" | "conflict";
export interface IntentDimensionAssessment {
  dimension: IntentDimension;
  status: IntentDimensionStatus;
  summary: string;
  evidenceIds: string[];
  metricKeys: string[];
  missingContext?: string[];
}


export interface IntentContext {
  kinds: string[];
  callers: number;
  tests: number;
  specifications: number;
  coverage: number;
  registrations: number;
  publicSurface: number;
  providerIds: string[];
  independentProviders: number;
  generatedSignals: number;
  dynamicSignals: number;
  relevantCompleteness: "complete" | "partial" | "abstained";
}

export interface IntentDecisionStep {
  id: string;
  result: IntentStepResult;
  summary: string;
  evidenceIds: string[];
  missingContext?: string[];
}

export interface IntentHypothesis {
  kind: IntentHypothesisKind;
  confidence: FindingConfidence;
  explanation: string;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
}

export interface IntentAssessment {
  findingId: string;
  criteria: readonly string[];
  profile: IntentReviewProfile;
  dimensions: IntentDimensionAssessment[];
  forensics?: ForensicMetrics;
  status: IntentAssessmentStatus;
  context: IntentContext;
  hypotheses: IntentHypothesis[];
  decisionTrace: IntentDecisionStep[];
  missingContext: string[];
  actionLimit: MaximumAction;
  humanDecisionRequired: true;
}

const ACTION_ORDER: Record<MaximumAction, number> = {
  ignore: 0,
  observe: 1,
  propose: 2,
  "delegate-safe-fix": 3,
};

function capAction(value: MaximumAction, cap: MaximumAction): MaximumAction {
  return ACTION_ORDER[value] <= ACTION_ORDER[cap] ? value : cap;
}

function confidenceFor(finding: Finding, cap: FindingConfidence = finding.confidence): FindingConfidence {
  const order: Record<FindingConfidence, number> = { C1: 1, C2: 2, C3: 3 };
  return order[finding.confidence] <= order[cap] ? finding.confidence : cap;
}
function normalizeProfile(profile?: Partial<IntentReviewProfile>): IntentReviewProfile {
  const values = (items: unknown): string[] => Array.isArray(items) ? items.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
  const artifact = profile?.artifact;
  const task = profile?.task;
  return {
    artifact: artifact && ["library", "application", "cli", "service", "test", "documentation", "unknown"].includes(artifact) ? artifact : DEFAULT_REVIEW_PROFILE.artifact,
    task: task && ["bug-review", "maintenance", "security", "api-review", "cleanup", "unknown"].includes(task) ? task : DEFAULT_REVIEW_PROFILE.task,
    audience: typeof profile?.audience === "string" && profile.audience.trim() ? profile.audience.trim() : undefined,
    expectedProperties: values(profile?.expectedProperties),
    toleratedPatterns: values(profile?.toleratedPatterns),
    prohibitedPatterns: values(profile?.prohibitedPatterns),
  };
}

function overlap(finding: Finding, record: EvidenceRecord): boolean {
  const source = record.source;
  return Boolean(
    source &&
      source.filePath === finding.filePath &&
      source.sourceHash === finding.sourceHash &&
      source.end >= finding.start &&
      source.start <= finding.end,
  );
}

function idsFromDetails(record: EvidenceRecord, key: string): string[] {
  const value = record.details?.[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function detailFlag(record: EvidenceRecord, keys: string[]): boolean {
  return keys.some((key) => {
    const value = record.details?.[key];
    return value === true || (typeof value === "string" && value.length > 0);
  });
}

function contextFor(finding: Finding, evidence: EvidenceRecord[]): { context: IntentContext; related: EvidenceRecord[] } {
  const ownEvidence = new Set([...finding.evidenceIds, ...finding.counterEvidenceIds]);
  const linked = evidence.filter((record) => ownEvidence.has(record.id));
  const related = evidence.filter((record) => !ownEvidence.has(record.id) && overlap(finding, record));
  const contextualEvidence = [...linked, ...related];
  const callers = new Set<string>();
  const tests = new Set<string>();
  const specifications = new Set<string>();
  const providerIds = new Set<string>();
  let coverage = 0;
  let registrations = 0;
  let publicSurface = 0;
  let generatedSignals = /(?:^|\/)(?:dist|build|coverage|node_modules|vendor|generated)(?:\/|$)|(?:^|\/)(?:generated|vendor)[^/]*$/i.test(finding.filePath) ? 1 : 0;
  let dynamicSignals = finding.unknown.filter((item) => /dynamic|external|reflection|runtime|framework/i.test(item)).length;
  for (const record of contextualEvidence) {
    providerIds.add(record.providerId);
    for (const caller of idsFromDetails(record, "callers")) callers.add(caller);
    for (const test of idsFromDetails(record, "tests")) tests.add(test);
    for (const specification of idsFromDetails(record, "governingSpecifications")) specifications.add(specification);
    if (record.kind === "coverage") coverage += 1;
    if (record.providerId === "repository-graph" && /registration/i.test(record.summary)) registrations += 1;
    if (record.kind === "policy" && /public-surface|export/i.test(record.summary)) publicSurface += 1;
    if (record.kind === "provenance" && (/generated|vendor|vendored|machine-maintained/i.test(record.summary) || detailFlag(record, ["generated", "vendored"]))) generatedSignals += 1;
    if (/dynamic|external consumer|reflection|runtime-only/i.test(record.summary) || detailFlag(record, ["dynamic", "external", "runtimeOnly"])) dynamicSignals += 1;
  }
  const context: IntentContext = {
    kinds: [...new Set(related.map((record) => record.kind))],
    callers: callers.size,
    tests: tests.size,
    specifications: specifications.size,
    coverage,
    registrations,
    providerIds: [...providerIds].sort(),
    independentProviders: providerIds.size,
    generatedSignals,
    dynamicSignals,
    relevantCompleteness: "partial",
    publicSurface,
  };
  return { context, related };
}
function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function relatedIds(related: EvidenceRecord[], predicate: (record: EvidenceRecord) => boolean): string[] {
  return related.filter(predicate).map((record) => record.id);
}

function hasBehaviorContext(context: IntentContext): boolean {
  return context.callers > 0 || context.tests > 0 || context.specifications > 0 || context.coverage > 0;
}

function hypothesis(
  kind: IntentHypothesisKind,
  confidence: FindingConfidence,
  explanation: string,
  supportingEvidenceIds: string[],
  contradictingEvidenceIds: string[],
): IntentHypothesis {
  return { kind, confidence, explanation, supportingEvidenceIds, contradictingEvidenceIds };
}
function assessDimensions(
  finding: Finding,
  result: ScanResult,
  context: IntentContext,
  related: EvidenceRecord[],
  profile: IntentReviewProfile,
  forensics?: ForensicMetrics,
): IntentDimensionAssessment[] {
  const allEvidence = result.evidenceRecords.filter((record) => related.includes(record) || finding.evidenceIds.includes(record.id) || finding.counterEvidenceIds.includes(record.id));
  const idsFor = (predicate: (record: EvidenceRecord) => boolean): string[] => allEvidence.filter(predicate).map((record) => record.id);
  const rule = `${finding.ruleId} ${finding.message}`.toLowerCase();
  const assessment = (dimension: IntentDimension, status: IntentDimensionStatus, summary: string, evidenceIds: string[] = [], missingContext?: string[], metricKeys: string[] = []): IntentDimensionAssessment => ({
    dimension,
    status,
    summary,
    evidenceIds: [...new Set(evidenceIds)],
    metricKeys: [...new Set(metricKeys)],
    missingContext,
  });
  const relevance = context.callers || context.tests || context.specifications || context.coverage
    ? assessment("relevance", "observed", "Repository behavior or verification context is linked to the finding.", relatedIds(related, (record) => record.kind === "reference" || record.kind === "test" || record.kind === "coverage" || record.kind === "policy"))
    : assessment("relevance", "unknown", "Task relevance cannot be established from static context alone.", [], ["Provide the task, requirements, callers, or governing specifications."]);
  const factuality = finding.counterEvidence.length
    ? assessment("factuality", "conflict", "Counterevidence prevents an unqualified factual defect claim.", finding.counterEvidenceIds)
    : finding.classification === "defect" && idsFor((record) => ["diagnostic", "syntax", "type", "resolution", "control-flow", "data-flow"].includes(record.kind)).length
      ? assessment("factuality", "observed", "Deterministic analyzer evidence supports a concrete behavioral or correctness issue.", finding.evidenceIds)
      : assessment("factuality", "unknown", "No independent deterministic correctness evidence was linked.", [], ["Verify the claimed behavior with tests, diagnostics, or a reproducible case."]);
  const density = /density|verbosity|waste|boilerplate|pass-through|redundant|duplicate/.test(rule)
    ? assessment("density", "observed", "The finding identifies potentially low-value or excessive structure; size alone is not proof of waste.", finding.evidenceIds)
    : assessment("density", "unknown", "Information density is not established by this finding.", [], ["Assess delivered behavior against the task before treating extra structure as low value."]);
  const repetition = /repeat|duplicate|redund|repetition|pass-through/.test(rule)
    ? assessment("repetition", "observed", "Repeated structure is present in deterministic finding evidence.", finding.evidenceIds)
    : assessment("repetition", "unknown", "Repetition was not independently established.", [], ["Check semantic equivalence before consolidating similar code."]);
  const templatedness = /template|boilerplate|pass-through|wrapper/.test(rule)
    ? assessment("templatedness", "observed", "A formulaic or forwarding structure was identified; framework boundaries may justify it.", finding.evidenceIds)
    : assessment("templatedness", "unknown", "Templatedness was not independently established.", [], ["Check registrations, generated sources, and compatibility boundaries."]);
  const coherence = context.kinds.some((kind) => kind === "control-flow" || kind === "data-flow") || /coherence|state|control.flow|data.flow/.test(rule)
    ? assessment("coherence", "observed", "Control-flow or data-flow evidence provides a basis for reviewing behavioral coherence.", idsFor((record) => record.kind === "control-flow" || record.kind === "data-flow"))
    : assessment("coherence", "unknown", "Behavioral coherence requires repository and runtime context beyond this finding.", [], ["Inspect state transitions, callers, and relevant tests."]);
  const tone = /tone|style|comment|naming|documentation|docs/.test(rule) || profile.artifact === "documentation"
    ? assessment("tone", "observed", "The finding includes a style or audience-sensitive signal; it is advisory only.", finding.evidenceIds)
    : assessment("tone", "unknown", "Tone and audience fit are not evaluated for this code finding.", [], ["Supply audience and artifact expectations before acting on style."]);
  const dimensions = [relevance, factuality, density, repetition, templatedness, coherence, tone];
  if (forensics) {
    const keys: Record<IntentDimension, string[]> = {
      relevance: [],
      factuality: ["claimDensity"],
      density: ["logicDensity", "claimDensity"],
      repetition: ["repetition"],
      templatedness: ["repetition", "stylometricFingerprint"],
      coherence: ["argumentDependency", "interchangeability", "burstiness"],
      tone: ["stylometricFingerprint", "burstiness"],
    };
    for (const item of dimensions) item.metricKeys = keys[item.dimension];
  }
  return dimensions;
}

export function assessIntent(finding: Finding, result: ScanResult, profileInput?: Partial<IntentReviewProfile>, forensics?: ForensicMetrics): IntentAssessment {
  const completeness = result.completeness ?? assessScanCompleteness(result);
  const { context, related } = contextFor(finding, result.evidenceRecords);
  const findingSkipped = result.skipped.some((item) => samePath(item.filePath, finding.filePath));
  const findingScanned = result.scannedFiles.some((filePath) => samePath(filePath, finding.filePath));
  context.relevantCompleteness = completeness.status === "abstained" ? "abstained" : findingSkipped || !findingScanned ? "partial" : "complete";
  const decisionTrace: IntentDecisionStep[] = [];
  const missingContext: string[] = [];
  const hypotheses: IntentHypothesis[] = [];
  const behavioralEvidenceIds = relatedIds(related, (record) => record.kind === "reference" || record.kind === "test" || record.kind === "coverage" || record.kind === "policy");
  const profile = normalizeProfile(profileInput);
  const dimensions = assessDimensions(finding, result, context, related, profile, forensics);
  const observedDimensions = dimensions.filter((item) => item.status === "observed");
  const conflictingDimensions = dimensions.filter((item) => item.status === "conflict");
  if (forensics) {
    decisionTrace.push({
      id: "forensic-signals",
      result: "pass",
      summary: `Local ${forensics.inputKind} forensics measured burstiness, a model-free perplexity proxy, repetition, logic density, and a stylometric fingerprint; these are descriptive signals, not provenance or authorship proof.`,
      evidenceIds: [],
      missingContext: forensics.limitations,
    });
  }
  decisionTrace.push({
    id: "dimension-gate",
    result: conflictingDimensions.length ? "conflict" : observedDimensions.length ? "pass" : "unknown",
    summary: conflictingDimensions.length
      ? "At least one quality dimension has conflicting evidence."
      : observedDimensions.length
        ? `${observedDimensions.length} quality dimension(s) have evidence; unobserved dimensions remain unknown rather than negative.`
        : "No paper-derived quality dimension has sufficient evidence for assessment.",
    evidenceIds: [...new Set(dimensions.flatMap((item) => item.evidenceIds))],
  });
  if (profile.expectedProperties.length || profile.prohibitedPatterns.length || profile.toleratedPatterns.length) {
    const profileEvidence = relatedIds(related, (record) => record.kind === "policy" || record.kind === "reference" || record.kind === "test");
    const profileReady = context.specifications > 0 || context.callers > 0 || context.tests > 0;
    const profileReason = profileReady
      ? "The review profile has repository context to compare expected, tolerated, and prohibited properties."
      : "The review profile is present, but no task or contract evidence is linked to compare its expectations.";
    decisionTrace.push({ id: "review-profile", result: profileReady ? "pass" : "unknown", summary: profileReason, evidenceIds: profileEvidence, missingContext: profileReady ? undefined : [profileReason] });
    if (!profileReady) missingContext.push(profileReason);
  }

  if (completeness.status === "complete") {
    decisionTrace.push({ id: "scan-completeness", result: "pass", summary: "The scan completed without skipped or omitted context.", evidenceIds: [] });
  } else {
    const reason = "Complete repository context is required before making a positive intent determination.";
    missingContext.push(reason);
    decisionTrace.push({ id: "scan-completeness", result: "unknown", summary: reason, evidenceIds: [], missingContext: [reason] });
  }
  if (context.relevantCompleteness === "complete") {
    decisionTrace.push({ id: "relevant-scope", result: "pass", summary: "The finding's source file was scanned and was not skipped.", evidenceIds: [] });
  } else {
    const reason = context.relevantCompleteness === "abstained"
      ? "The finding's relevant scan scope was abstained."
      : "The finding's source file was skipped or was not included in the scanned file set.";
    missingContext.push(reason);
    decisionTrace.push({ id: "relevant-scope", result: "unknown", summary: reason, evidenceIds: [], missingContext: [reason] });
  }

  if (context.registrations || context.publicSurface) {
    const support = relatedIds(related, (record) =>
      (record.providerId === "repository-graph" && /registration/i.test(record.summary)) || (record.kind === "policy" && /public-surface|export/i.test(record.summary)),
    );
    hypotheses.push(hypothesis(
      context.registrations ? "framework-required" : "compatibility-boundary",
      "C2",
      context.registrations ? "Repository context shows a framework or runtime registration." : "Repository context shows public-surface or export evidence.",
      support,
      [],
    ));
    decisionTrace.push({ id: "public-boundary", result: "pass", summary: "The finding overlaps a public or registered boundary.", evidenceIds: support });
  } else {
    const reason = "No public-surface or framework-registration context was linked to the finding.";
    missingContext.push(reason);
    decisionTrace.push({ id: "public-boundary", result: "unknown", summary: "No public or registered boundary was found in available context.", evidenceIds: [], missingContext: [reason] });
  }

  if (hasBehaviorContext(context)) {
    hypotheses.push(hypothesis(
      "likely-intentional",
      confidenceFor(finding, "C2"),
      "Callers, tests, specifications, or coverage show connected behavior that may be an intentional contract.",
      behavioralEvidenceIds,
      finding.counterEvidenceIds,
    ));
    decisionTrace.push({ id: "behavioral-contract", result: "pass", summary: "Behavioral or verification context is present.", evidenceIds: behavioralEvidenceIds });
  } else {
    const reason = "No callers, tests, specifications, or coverage were linked to the finding.";
    missingContext.push(reason);
    decisionTrace.push({ id: "behavioral-contract", result: "unknown", summary: "No behavioral contract context was found; absence is not proof of unused code.", evidenceIds: [], missingContext: [reason] });
  }
  if (context.independentProviders >= 2) {
    decisionTrace.push({
      id: "evidence-diversity",
      result: "pass",
      summary: `Independent evidence providers corroborate the context (${context.providerIds.join(", ")}).`,
      evidenceIds: behavioralEvidenceIds,
    });
  } else {
    const reason = "Only one or no independent evidence provider supports the contextual assessment.";
    missingContext.push(reason);
    decisionTrace.push({ id: "evidence-diversity", result: "unknown", summary: `${reason} Provider count is not proof of intent.`, evidenceIds: [], missingContext: [reason] });
  }

  if (context.generatedSignals) {
    const support = [...new Set([...relatedIds(related, (record) => record.kind === "provenance"), ...finding.evidenceIds])];
    hypotheses.push(hypothesis(
      "generated-or-vendored",
      "C2",
      "The finding is associated with generated, vendored, or machine-maintained code; ownership and regeneration rules must be checked before changing it.",
      support,
      [],
    ));
    const reason = "Ownership, source-of-truth, and regeneration rules are required for generated or vendored code.";
    missingContext.push(reason);
    decisionTrace.push({ id: "generated-origin", result: "pass", summary: "Generated or vendor-like origin signals were found; this is context, not proof of low value.", evidenceIds: support, missingContext: [reason] });
  }

  if (context.dynamicSignals) {
    const support = relatedIds(related, (record) => /dynamic|external consumer|reflection|runtime-only/i.test(record.summary));
    hypotheses.push(hypothesis(
      "external-or-dynamic-context",
      "C1",
      "Dynamic, reflective, runtime-only, or externally consumed behavior may not be visible in the static repository graph.",
      support,
      [],
    ));
    const reason = "Runtime registration, reflection, external consumers, and dynamic loading require explicit verification.";
    missingContext.push(reason);
    decisionTrace.push({ id: "dynamic-context", result: "unknown", summary: reason, evidenceIds: support, missingContext: [reason] });
  }

  if (finding.classification === "defect" && finding.confidence !== "C1" && !finding.counterEvidence.length && completeness.status === "complete") {
    hypotheses.push(hypothesis(
      "likely-defect",
      finding.confidence,
      "The deterministic finding identifies a concrete defect without known counterevidence.",
      finding.evidenceIds,
      [],
    ));
    decisionTrace.push({ id: "deterministic-defect", result: "pass", summary: "Deterministic defect evidence is available without known counterevidence.", evidenceIds: finding.evidenceIds });
  } else if (finding.counterEvidence.length) {
    decisionTrace.push({ id: "deterministic-defect", result: "conflict", summary: "The finding has counterevidence that prevents an unqualified defect conclusion.", evidenceIds: finding.counterEvidenceIds });
  } else {
    decisionTrace.push({ id: "deterministic-defect", result: "unknown", summary: "The available evidence does not establish a concrete defect.", evidenceIds: [] });
  }

  if (finding.classification === "waste_candidate" && !hypotheses.some((item) => item.kind === "likely-intentional" || item.kind === "framework-required" || item.kind === "compatibility-boundary")) {
    hypotheses.push(hypothesis(
      "duplicate-contract",
      confidenceFor(finding, "C1"),
      "The scanner found a possible duplicate or low-value structure, but repository intent is not established.",
      finding.evidenceIds,
      finding.counterEvidenceIds,
    ));
  }
  if (!hypotheses.some((item) => item.kind === "likely-intentional" || item.kind === "framework-required" || item.kind === "compatibility-boundary" || item.kind === "likely-defect")) {
    hypotheses.push(hypothesis(
      "suspicious-structure",
      confidenceFor(finding, "C1"),
      "The finding describes suspicious or low-value structure, but intent is not established by static context.",
      finding.evidenceIds,
      [...finding.counterEvidenceIds, ...behavioralEvidenceIds],
    ));
  }
  const contested = finding.counterEvidence.length > 0 || finding.unknown.length > 0 || hypotheses.some((item) => item.contradictingEvidenceIds.length > 0);
  const supportedHypothesis = hypotheses.some((item) => item.kind === "likely-intentional" || item.kind === "framework-required" || item.kind === "compatibility-boundary" || item.kind === "likely-defect");
  const status: IntentAssessmentStatus = completeness.status !== "complete" ? "unknown" : contested ? "contested" : supportedHypothesis ? "supported" : "unknown";
  const authorityEvidenceIds = [...new Set(hypotheses.flatMap((item) => [...item.supportingEvidenceIds, ...item.contradictingEvidenceIds]))];
  decisionTrace.push({
    id: "intent-authority",
    result: status === "supported" ? "pass" : status === "contested" ? "conflict" : "unknown",
    summary: status === "supported"
      ? "At least one supported intent or defect hypothesis remains after the evidence gates."
      : status === "contested"
        ? "Conflicting or unresolved evidence prevents an unqualified intent determination."
        : "The available context is insufficient for a positive intent determination.",
    evidenceIds: authorityEvidenceIds,
    missingContext: status === "unknown" ? [...new Set(missingContext)] : undefined,
  });
  const actionRequiresReview = context.generatedSignals > 0 || context.dynamicSignals > 0;
  const actionLimit = status === "supported" && !actionRequiresReview && !finding.counterEvidence.length && finding.risk !== "R3"
    ? finding.maximumAction
    : capAction(finding.maximumAction, "observe");
  decisionTrace.push({
    id: "action-authority",
    result: actionLimit === finding.maximumAction ? "pass" : "unknown",
    summary: actionLimit === finding.maximumAction ? "The requested action remains within the evidence gates." : `Action is capped at ${actionLimit} pending human review or additional context.`,
    evidenceIds: authorityEvidenceIds,
  });
  return { findingId: finding.id, criteria: INTENT_CRITERIA, profile, dimensions, forensics, status, context, hypotheses, decisionTrace, missingContext: [...new Set(missingContext)], actionLimit, humanDecisionRequired: true };
}

export function formatIntentAssessment(assessment: IntentAssessment): string {
  const statusMeaning: Record<IntentAssessmentStatus, string> = {
    supported: "At least one evidence-backed hypothesis remains after the review gates.",
    contested: "Evidence conflicts or remains unresolved; do not treat this as a settled conclusion.",
    unknown: "Available repository evidence is insufficient for a positive determination.",
  };
  const actionMeaning: Record<MaximumAction, string> = {
    ignore: "No action is recommended from this assessment alone.",
    observe: "Gather more context; do not propose or apply a change from this assessment alone.",
    propose: "A human may consider a narrowly scoped proposal after reviewing the cited evidence.",
    "delegate-safe-fix": "A human may consider delegating a narrowly scoped fix after reviewing and validating the cited evidence.",
  };
  const evidence = (ids: string[]): string => ids.length ? ids.join(", ") : "none";
  const lines = [
    "HUMAN DECISION REQUIRED",
    "This assessment is advisory evidence, not authorization to change code.",
    "",
    "DECISION SUMMARY",
    `  Assessment: ${assessment.status.toUpperCase()} — ${statusMeaning[assessment.status]}`,
    `  Recommended handling: ${assessment.actionLimit}`,
    `  What that means: ${actionMeaning[assessment.actionLimit]}`,
    `  Finding: ${assessment.findingId}`,
    "",
    "REVIEW PROFILE",
    `  Profile: artifact=${assessment.profile.artifact}, task=${assessment.profile.task}${assessment.profile.audience ? `, audience=${assessment.profile.audience}` : ""}`,
    `  Artifact: ${assessment.profile.artifact}`,
    `  Task: ${assessment.profile.task}`,
    `  Audience: ${assessment.profile.audience || "not specified"}`,
    `  Expected properties: ${assessment.profile.expectedProperties.join(", ") || "none specified"}`,
    `  Tolerated patterns: ${assessment.profile.toleratedPatterns.join(", ") || "none specified"}`,
    `  Prohibited patterns: ${assessment.profile.prohibitedPatterns.join(", ") || "none specified"}`,
    "",
    "FORENSICS",
    assessment.forensics
      ? `  Forensics: kind=${assessment.forensics.inputKind}; ${assessment.forensics.tokenCount} tokens; descriptive only: burstiness CV=${assessment.forensics.burstiness.coefficientOfVariation ?? "n/a"}; perplexity proxy=${assessment.forensics.perplexityProxy.value ?? "n/a"}; repeated lines=${assessment.forensics.repetition.repeatedLineRate}; repeated trigrams=${assessment.forensics.repetition.repeatedTrigramRate}; claim rate=${assessment.forensics.claimDensity.falsifiableClaimRate}; jargon rate=${assessment.forensics.claimDensity.jargonTokenRate}; interchangeability=${assessment.forensics.interchangeability.interchangeabilityIndex ?? "unknown"}`
      : "  Not requested.",
    "  These signals do not establish authorship, provenance, or AI origin.",
    "",
    "Quality dimensions:",
    ...assessment.dimensions.map((item) => `  ${item.status.toUpperCase()} ${item.dimension}: ${item.summary} [evidence: ${evidence(item.evidenceIds)}${item.metricKeys.length ? `; metrics: ${item.metricKeys.join(", ")}` : ""}]`),
    "",
    "DECISION TRACE",
    ...assessment.decisionTrace.map((step) => `  ${step.result.toUpperCase()} ${step.id}: ${step.summary} [evidence: ${evidence(step.evidenceIds)}]`),
    "",
    "COMPETING HYPOTHESES",
    ...assessment.hypotheses.map((item) => `  ${item.kind} (${item.confidence}): ${item.explanation} [supports: ${evidence(item.supportingEvidenceIds)}; contradicts: ${evidence(item.contradictingEvidenceIds)}]`),
  ];
  if (assessment.missingContext.length) lines.push("", "NEXT HUMAN CHECKS", ...assessment.missingContext.map((item) => `  - ${item}`));
  return lines.join("\n");
}
