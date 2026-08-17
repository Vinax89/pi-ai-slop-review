# Changelog

## Unreleased

- Add independent, dependency-free repository import-cycle analysis over resolved graph edges.
- Preserve type-only edge provenance, suppress all-type-only cycles, and require complete repository scope before emitting cycle candidates.
- Detect explicit placeholder-only TypeScript/JavaScript function bodies as context-dependent observations.
- Harden graph analysis against per-specifier type imports, stale out-of-scope facts, deep graphs, control-character paths, and oversized cycle summaries.
- Add indexed cycle queries, actionable arrow-function names, and positive/hard-negative placeholder evaluation cases.
- Make complete clean repository scans prune stale graph facts while partial and explicit scans preserve unobserved state.
- Store cycle edge provenance as bounded counts instead of potentially large identifier arrays.
- Render cycle membership without implying a traversal order and sanitize source-controlled placeholder names in diagnostics.
- Add release-facing skill assertions for conservative cycle and placeholder adjudication without third-party branding.

## 2.0.1

- Require positive evidence or complete reference coverage before confirming wrapper redundancy.
- Require positive maintenance-risk evidence before confirming exact duplicate implementations.
- Recognize workspace and whole-project aliases for repository review.
- Clarify that evidence IDs are finding-scoped and live-provider metrics are experimental.
- Correct two blind labels that had inferred redundancy from missing caller or contract evidence.

## 2.0.0

- Invalidate stored verdicts with a full adjudication-context fingerprint rather than source hash alone.
- Distinguish resolved findings from partial-scan not-observed/out-of-scope records.
- Replace free-form verdict verification and recording with atomic, checkpointed `slop_submit_verdicts` batches.
- Separate unreviewed candidates from genuinely adjudicated `needs-context` verdicts in manifests.
- Make deep adjudication explicit-only, neutralize internal review terminology, and disable forensics by default.
- Add blind, provider-adaptable end-to-end harness evaluation and context-change/injection regression coverage.
