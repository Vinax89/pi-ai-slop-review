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

## Performance
`npm run benchmark` measures a deterministic 40-file TypeScript fixture, asserts cold/warm scan correctness and complete coverage plus graph-query identity, records cold/warm federated scans, graph query latency, RSS change, runtime metadata, and writes the same expanded input hashes to `artifacts/benchmark.json`. Targets are directional and cannot justify weaker correctness or safety.
