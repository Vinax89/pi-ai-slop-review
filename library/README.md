# AI Slop Review Context Library

This library supports evidence-backed review of AI-assisted changes. It does not infer AI authorship from style and does not treat ordinary defects as AI-specific.

## Finding classes

- `defect`: direct evidence of invalid or incorrect behavior.
- `waste_candidate`: implementation surface that may be unnecessary but is not yet proven removable.
- `context_conflict`: a change conflicts with repository contracts or duplicates existing capability.
- `assurance_gap`: claims exceed the available verification evidence.
- `review_externality`: a contribution shifts material verification or maintenance work to reviewers.

## Confidence

- `C1`: one heuristic signal.
- `C2`: independent structural or contextual signals converge.
- `C3`: a compiler, resolver, test, or authoritative contract establishes the finding.

Confidence describes the finding, not the safety of a fix. Structural removal always requires a separate removability review.

## Safety policy

The extension is read-only by default. It must abstain when parsing fails, evidence is stale, or required context is unavailable. It never installs unresolved packages, inserts throws, removes wrappers, or deletes files automatically. Patch application is available only after isolated proof checks and an explicit user command; R3, file-deleting, and critical-path patches remain blocked.

`rules.yaml` is the executable cap on confidence, risk, and action. `cases.jsonl` is partitioned by repository into train, validation, and holdout splits; cross-split repository leakage and unsafe hard-negative actions fail evaluation.

An AI-slop candidate requires explicit AI provenance, a substantive `C2`/`C3` finding, a corroborating context conflict or assurance gap, and no hard veto. Otherwise the concrete finding is reported without an AI label.
