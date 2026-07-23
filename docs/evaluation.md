# Evaluation

## Corpus policy

`library/cases.jsonl` is reason-labeled, provenance-blind, and repository-separated into train, validation, and holdout splits. A repository identifier may occur in only one split. Labels distinguish defects, context conflicts, assurance gaps, ambiguous observations, waste candidates, and hard negatives.

## Promotion metrics

- Actionable precision, not finding volume.
- Unsafe hard-negative actions must remain zero.
- Per-rule acceptance and rejection reasons.
- Wilson lower bounds and selective risk thresholds after at least 20 local samples.
- Conformal acceptance thresholds from accepted local examples.
- Abstention and coverage reported separately.
- Repository-level splits; no file/function random leakage.

Unknown or unhealthy rules are observation-only. Any unsafe feedback disables proposal authority for that rule locally.

## Current automated gates

`npm run evaluate` requires every bundled case to match its expected action, zero unsafe hard-negative actions, no repository split leakage, and a non-empty holdout. The generated result is `artifacts/evaluation.json`.

The corpus is a regression suite, not a claim of population-level accuracy. Real-repository expansion must preserve licensing, blind annotators to provenance, record disagreements, and keep evaluation repositories out of rule development.

## Performance

`npm run benchmark` measures a deterministic 40-file TypeScript fixture, cold/warm federated scans, graph query latency, and RSS change. Targets are directional and cannot justify weaker correctness or security.
