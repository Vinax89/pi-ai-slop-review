# Evaluation

## Corpus policy

`library/cases.jsonl` is reason-labeled, provenance-blind, and repository-separated into train, validation, and holdout splits. A repository identifier may occur in only one split. Labels distinguish defects, context conflicts, assurance gaps, ambiguous observations, waste candidates, and hard negatives.

## Promotion metrics

- Actionable precision is `non-hard-negative propose/delegate actions / all propose/delegate actions`; it is `null` when no actionable finding is emitted.
- Case correctness is stricter than actionable precision: expected action must match, expected confidence (when present) must match, and every declared veto must occur in matching counterevidence.
- Unsafe hard-negative actions must remain zero.
- Per-rule acceptance and rejection reasons.
- Wilson lower bounds and selective risk thresholds after at least 20 local samples.
- Conformal acceptance thresholds from accepted local examples.
- Abstention and coverage reported separately.
- Repository-level splits; no file/function random leakage.

Unknown or unhealthy rules are observation-only. Any unsafe feedback disables proposal authority for that rule locally.

## Current automated gates

`npm run evaluate` validates unique IDs, non-empty train/validation/holdout splits, repository isolation, anchored action/confidence/veto expectations, zero unsafe hard-negative actions, and writes language coverage plus Node/Python runtime metadata. Artifacts are integrity-bound to deterministic SHA-256 hashes of code, corpus, executable rules, full library, schemas, package lock metadata, effective configuration, and runtime metadata.


The corpus is a regression suite, not a claim of population-level accuracy. Real-repository expansion must preserve licensing, blind annotators to provenance, record disagreements, and keep evaluation repositories out of rule development.

## Blind end-to-end adjudication

`npm run evaluate:e2e` runs the complete skill/harness through an executable adapter named by `SLOP_E2E_ADAPTER`. The adapter can target any Pi-supported model/provider and returns a structurally validated tool transcript. Labels live in `evaluation-private/` and are loaded only by the evaluator; each run copies only unlabeled fixture source to the model-visible workspace. The evaluator reports verdict correctness, decided accuracy, abstention rate, repeatability, required tool order, exact label/static/adjudication set equality, label-scoped injection resistance, tool-call count, and optional token usage. Missing, duplicate, or hallucinated verdict keys fail coverage. Run heterogeneous adapters separately and compare these model-adjudication metrics independently from `npm run evaluate`, which reports deterministic scanner metrics.

Live-provider results are experimental observations, not a release gate or a claim of cross-provider reliability. After the 2026-08-17 policy audit corrected two labels that had treated missing caller/contract evidence as proof, the recorded smoke transcripts achieved exact 8/8 tool coverage with both DeepSeek V4 Pro and OpenAI GPT-5.6 Sol, while matching 8/8 and 6/8 private verdict labels respectively; repeatability was not established. Deterministic scanner gates remain separate and must not be presented as LLM adjudication accuracy.

## Performance
`npm run benchmark` measures a deterministic 40-file TypeScript fixture, asserts cold/warm scan correctness and complete coverage plus graph-query identity, records cold/warm federated scans, graph query latency, RSS change, runtime metadata, and writes the same expanded input hashes to `artifacts/benchmark.json`. Targets are directional and cannot justify weaker correctness or safety.
