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

`npm run evaluate:e2e` runs the complete skill/harness through an executable adapter named by `SLOP_E2E_ADAPTER`. The adapter can target any Pi-supported model/provider and returns a structurally validated tool transcript. Maintainer checkouts default to `artifacts/verdict-corpus` and `evaluation-private/verdict-labels.json`; published-package users must provide external `SLOP_E2E_FIXTURES` and `SLOP_E2E_LABELS` paths because private evaluation data is intentionally excluded from npm. Labels must resolve outside the fixture tree, are loaded only by the evaluator, and are never copied into the model-visible workspace. Fixture trees reject symlinks, hard links, and special files, enforce file/byte ceilings, and are revalidated before and after copying. The evaluator reports verdict correctness, decided accuracy, abstention rate, repeatability, strict first-occurrence tool order, exact label/static/adjudication set equality, label-scoped injection resistance, tool-call count, and optional token usage. Missing, duplicate, or hallucinated verdict keys fail coverage. Run heterogeneous adapters separately and compare these model-adjudication metrics independently from `npm run evaluate`, which reports deterministic scanner metrics.

Live-provider results are experimental observations, not a release gate or a claim of cross-provider reliability. After the 2026-08-17 policy audit corrected two labels that had treated missing caller/contract evidence as proof, the recorded smoke transcripts achieved exact 8/8 tool coverage with both DeepSeek V4 Pro and OpenAI GPT-5.6 Sol, while matching 8/8 and 6/8 private verdict labels respectively; repeatability was not established. Deterministic scanner gates remain separate and must not be presented as LLM adjudication accuracy.

## Private real-repository corpus

Real-repository expansion lives outside the package tree. Set `SLOP_REPOSITORY_MANIFEST` to an external manifest matching `schema/repository-corpus-manifest.schema.json`, then run `npm run evaluate:repositories:sync` and `npm run evaluate:repositories`. The manifest pins each repository to a full commit and one repository-level split. Training and validation checkouts must have the exact credential-free HTTPS origin, exact commit, and no tracked or untracked changes.

Normal synchronization and collection intentionally skip the holdout and fail if its checkout exists. This prevents accidental observation before the skill version and evaluation protocol are frozen. The collector copies only bounded, tracked source/configuration files into a model-visible fixture tree; it excludes Git metadata, symlinks, hard links, special files, oversized files, labels, and reviewer identities. It revalidates each checkout after collection to detect drift.

The generated index keeps deterministic scan results separate from human labels. Candidate selection uses a fixed 60/40 training/validation target and balances detector families and repositories where the available findings permit. Clean control files are sampled separately. `review-template.json` may be regenerated, while `reviewer-a.json` and `reviewer-b.json` are preserved once they contain human work; a changed case set then fails closed instead of overwriting annotations. Two reviewers label independently, disagreements are adjudicated only after both sheets are complete, and deterministic scanner metrics remain separate from later LLM-adjudication metrics.

## Performance
`npm run benchmark` measures a deterministic 40-file TypeScript fixture, asserts cold/warm scan correctness and complete coverage plus graph-query identity, records cold/warm federated scans, graph query latency, RSS change, runtime metadata, and writes the same expanded input hashes to `artifacts/benchmark.json`. Targets are directional and cannot justify weaker correctness or safety.
