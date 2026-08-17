# Changelog

## Unreleased

- Add an external-manifest real-repository corpus pipeline with frozen repository-level splits, strict checkout provenance, holdout non-observation, bounded source-only fixtures, balanced candidate/control sampling, and independently preserved private review sheets.
- Keep private repository source and labels outside the npm package, and ship a strict corpus-manifest schema plus packaging/release privacy gates.
- Remove the retired Node type-transformation flag so development and evaluation scripts remain compatible through Node 26.
- Exclude provider timing jitter from scan and adjudication-context identities while retaining provider status, capabilities, versions, and diagnostics.
- Add independent, dependency-free repository import-cycle analysis over resolved graph edges.
- Preserve type-only edge provenance, suppress all-type-only cycles, and require complete repository scope before emitting cycle candidates.
- Detect explicit placeholder-only TypeScript/JavaScript function bodies as context-dependent observations.
- Harden graph analysis against per-specifier type imports, stale out-of-scope facts, deep graphs, control-character paths, and oversized cycle summaries.
- Add indexed cycle queries, actionable arrow-function names, and positive/hard-negative placeholder evaluation cases.
- Make complete clean repository scans prune stale graph facts while partial and explicit scans preserve unobserved state.
- Store cycle edge provenance as bounded counts instead of potentially large identifier arrays.
- Render cycle membership without implying a traversal order and sanitize source-controlled placeholder names in diagnostics.
- Add release-facing skill assertions for conservative cycle and placeholder adjudication without third-party branding.
- Reject verdict-manifest traversal and symlink escapes, and create exports through exclusive private temporary files.
- Enforce verdict batch, evidence, duplicate-ID, and normalized-rationale bounds in the transactional storage layer.
- Require exact private-label/static/adjudication set equality and validate untrusted blind-harness adapter transcripts.
- Deduplicate reverse cycle connectivity, budget cycle results deterministically, and retain exact count-only edge provenance.
- Detect explicit Python `NotImplementedError` placeholders and standard JavaScript error-subclass placeholder markers conservatively.
- Verify actual core-tool registrations and per-tool prompt guidance, and include the benchmark in `release:check`.
- Bound raw verdict inputs before normalization or deduplication and sanitize legacy rationale in reports and manifests.
- Reject symlinks and special files in blind fixtures, bound adapter dimensions and label files, and require exact external label separation.
- Prevent unsubmitted adjudication batches from being overwritten and return canonical batch/representative/report-only coverage metadata.
- Avoid placeholder false positives from shadowed JavaScript error constructors and Python `NotImplementedError` bindings.
- Let published-package users run blind evaluation with external fixture and label paths while keeping private evaluation data out of npm.
- Reject stale scans before adjudication, redisplay pending batches after context compaction, and resume interrupted full reviews from exact-scan persisted coverage.
- Distinguish graph-context query failure from an empty graph in verdict fingerprints.
- Reject hard-linked blind fixtures, revalidate copied workspaces, constrain label schemas, and require strict first-occurrence tool order.
- Add release-corpus hard negatives for project-shadowed placeholder exception constructors.
- Correct stale documentation about opt-in forensics, reusable verdict semantics, and the current completion-audit release.

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
