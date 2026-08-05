export const SCHEMA_VERSION = 1 as const;

export type SchemaVersion = typeof SCHEMA_VERSION;
export type FindingConfidence = "C1" | "C2" | "C3";
export type FindingClass = "defect" | "waste_candidate" | "context_conflict" | "assurance_gap" | "review_externality";
export type FindingRisk = "R1" | "R2" | "R3";
export type MaximumAction = "ignore" | "observe" | "propose" | "delegate-safe-fix";
export type EvidenceKind =
  | "diagnostic"
  | "syntax"
  | "type"
  | "resolution"
  | "reference"
  | "control-flow"
  | "data-flow"
  | "test"
  | "coverage"
  | "provenance"
  | "policy"
  | "counterevidence"
  | "unknown";

export interface SourceRange {
  filePath: string;
  line: number;
  column: number;
  start: number;
  end: number;
  sourceHash: string;
}

export interface EvidenceRecord {
  schemaVersion: SchemaVersion;
  id: string;
  providerId: string;
  providerVersion: string;
  kind: EvidenceKind;
  summary: string;
  strength: FindingConfidence;
  source?: SourceRange;
  details?: Record<string, unknown>;
}

export interface Finding extends SourceRange {
  schemaVersion: SchemaVersion;
  id: string;
  anchor: string;
  ruleId: string;
  classification: FindingClass;
  confidence: FindingConfidence;
  risk: FindingRisk;
  maximumAction: MaximumAction;
  message: string;
  evidence: string[];
  evidenceIds: string[];
  counterEvidence: string[];
  counterEvidenceIds: string[];
  unknown: string[];
}

export type FindingDraft = Omit<
  Finding,
  "schemaVersion" | "id" | "evidenceIds" | "counterEvidenceIds"
>;

export interface SkippedFile {
  filePath: string;
  reason: string;
  providerId?: string;
}

export interface ProviderRun {
  id: string;
  version: string;
  capabilities: ProviderCapability[];
  status: "completed" | "degraded" | "failed" | "skipped";
  durationMs?: number;
  diagnostic?: string;
}

export type ProviderCapability =
  | "syntax"
  | "types"
  | "resolution"
  | "symbols"
  | "references"
  | "call-hierarchy"
  | "control-flow"
  | "data-flow"
  | "diagnostics"
  | "coverage"
  | "dependencies"
  | "public-surface"
  | "tests";

export interface ScanScope {
  mode: "session" | "explicit" | "delta" | "repository";
  rootHash: string;
  contentHash: string;
  paths: string[];
  baselineId?: string;
}

export interface PolicyDecision {
  findingId: string;
  originalConfidence: FindingConfidence;
  finalConfidence: FindingConfidence;
  originalAction: MaximumAction;
  finalAction: MaximumAction;
  evidenceScore: number;
  reasons: string[];
}

export interface RuleHealth {
  ruleId: string;
  samples: number;
  accepted: number;
  rejected: number;
  unsafeActions: number;
  precision: number | null;
  wilsonLowerBound: number | null;
  selectiveThreshold: number | null;
  conformalThreshold: number | null;
  status: "insufficient-data" | "healthy" | "observe-only" | "disabled";
}

export interface ScanCompleteness {
  status: "complete" | "partial" | "abstained";
  scannedFiles: number;
  skippedItems: number;
  reasons: string[];
}

export interface ScanResult {
  schemaVersion: SchemaVersion;
  scanId: string;
  generatedAt: string;
  engine: "typescript-semantic" | "python-ast" | "semantic-review" | "provider-federation";
  engineVersion: string;
  scope: ScanScope;
  providers: ProviderRun[];
  evidenceRecords: EvidenceRecord[];
  scannedFiles: string[];
  findings: Finding[];
  suppressedFindings: Finding[];
  policyDecisions: PolicyDecision[];
  ruleHealth: RuleHealth[];
  skipped: SkippedFile[];
  completeness?: ScanCompleteness;
}

export interface Suppression {
  schemaVersion: SchemaVersion;
  id: string;
  ruleId: string;
  reason: string;
  createdAt: string;
  expiresAt?: string;
  filePath?: string;
  anchor?: string;
  sourceHash?: string;
}

export interface FeedbackRecord {
  schemaVersion: SchemaVersion;
  id: string;
  findingId: string;
  sourceHash?: string;
  ruleId: string;
  outcome:
    | "accepted"
    | "intentional"
    | "wrong-location"
    | "missing-context"
    | "duplicate"
    | "unsafe-proposal"
    | "insufficient-evidence"
    | "local-convention";
  reason: string;
  createdAt: string;
  repositoryId: string;
  findingConfidence: FindingConfidence;
  maximumAction: MaximumAction;
  providerIds: string[];
  evidenceScore: number;
  unsafe: boolean;
}

export interface ChangedRange {
  start: number;
  beforeEnd: number;
  afterEnd: number;
}

export interface MutationLedgerEvent {
  schemaVersion: SchemaVersion;
  id: string;
  kind: "mutation";
  toolCallId: string;
  toolName: string;
  filePath: string;
  beforeHash: string | null;
  afterHash: string | null;
  changedRange: ChangedRange;
  succeeded: boolean;
  timestamp: string;
}

export interface VerificationLedgerEvent {
  schemaVersion: SchemaVersion;
  id: string;
  kind: "verification";
  toolCallId: string;
  toolName: string;
  command: string;
  verificationKind: "build" | "format" | "lint" | "typecheck" | "unit-test" | "integration-test" | "security" | "custom" | "unclassified";
  authoritativeFor: string[];
  contentHashes: Record<string, string>;
  succeeded: boolean;
  timestamp: string;
}

export interface ClaimAssessment {
  schemaVersion: SchemaVersion;
  id: string;
  claim: string;
  type: "tests-passed" | "checks-passed" | "no-api-change" | "no-dependency-change" | "scope-only" | "behavior-preserved";
  status: "supported" | "refuted" | "unverifiable";
  evidence: string[];
  timestamp: string;
}

export type LedgerEvent = MutationLedgerEvent | VerificationLedgerEvent;

export interface StoredSession {
  id: string;
  branchId: string;
  updatedAt: string;
  events: LedgerEvent[];
  scans: ScanResult[];
  claims: ClaimAssessment[];
}

export interface ExperimentVariable {
  name: string;
  type: "integer" | "boolean";
  minimum?: number;
  maximum?: number;
}

export interface MetamorphicRelation {
  name: string;
  transform: Record<string, string>;
  relation: "equal" | "not-equal" | "nondecreasing" | "nonincreasing";
}

export interface ExperimentSpec {
  id: string;
  kind: "expression-equivalence";
  original: string;
  candidate: string;
  variables: ExperimentVariable[];
  properties: string[];
  metamorphic: MetamorphicRelation[];
  maximumCases: number;
}

export interface ExperimentResult {
  schemaVersion: SchemaVersion;
  id: string;
  specId: string;
  status: "verified" | "refuted" | "inconclusive" | "abstained";
  bounded: boolean;
  cases: number;
  counterexamples: Array<Record<string, unknown>>;
  generatedRegressionCases: Array<Record<string, unknown>>;
  generatedRegressionTests: string[];
  invariants: { original: Record<string, unknown>; candidate: Record<string, unknown> };
  mutation: { generated: number; killed: number; score: number | null };
  equalitySaturation: { originalCanonical: string; candidateCanonical: string; equivalent: boolean };
  cegis: { candidate?: string; iterations: number; counterexamples: number };
  metamorphic: Array<{ name: string; passed: boolean; counterexample?: Record<string, unknown> }>;
  assumptions: string[];
  diagnostic?: string;
}

export interface CriticAssessment {
  role: "finding-advocate" | "counterexample-reviewer" | "behavior-reviewer" | "test-security-reviewer";
  verdict: "support" | "oppose" | "abstain";
  citedEvidenceIds: string[];
  analysis: string;
  valid: boolean;
  diagnostic?: string;
}

export interface FormalVerificationResult {
  schemaVersion: SchemaVersion;
  id: string;
  engine: "bounded-exhaustive" | "smt" | "translation-validation";
  status: "verified" | "refuted" | "unknown" | "abstained";
  assumptions: string[];
  output: string;
  counterexample?: string;
}

export interface Proposal {
  schemaVersion: SchemaVersion;
  id: string;
  createdAt: string;
  baseCommit: string;
  patch: string;
  fileHashes: Record<string, string | null>;
  findingIds: string[];
  risk: FindingRisk;
  proofObligations: string[];
  commands: string[][];
  deletesFiles: boolean;
  criticalPaths: string[];
  experiments: ExperimentSpec[];
  appliedFileHashes?: Record<string, string | null>;
  status: "candidate" | "verified" | "rejected" | "applied" | "rolled-back";
}

export interface LabCheck {
  name: string;
  phase: "baseline" | "candidate" | "comparison" | "isolation";
  command?: string[];
  succeeded: boolean;
  exitCode?: number | null;
  durationMs: number;
  output: string;
}

export interface LabRun {
  schemaVersion: SchemaVersion;
  id: string;
  proposalId: string;
  createdAt: string;
  completedAt: string;
  networkIsolation: "bubblewrap";
  checks: LabCheck[];
  publicSurfaceChanged: boolean;
  experimentResults: ExperimentResult[];
  status: "verified" | "rejected" | "cancelled" | "aborted";
  diagnostic?: string;
}

export interface PersistedState {
  schemaVersion: SchemaVersion;
  revision: number;
  repositoryId: string;
  createdAt: string;
  updatedAt: string;
  sessions: Record<string, StoredSession>;
  suppressions: Suppression[];
  feedback: FeedbackRecord[];
  baselines: Record<string, ScanResult>;
  proposals: Proposal[];
  labRuns: LabRun[];
}
