# Changelog

## 2.0.0

- Invalidate stored verdicts with a full adjudication-context fingerprint rather than source hash alone.
- Distinguish resolved findings from partial-scan not-observed/out-of-scope records.
- Replace free-form verdict verification and recording with atomic, checkpointed `slop_submit_verdicts` batches.
- Separate unreviewed candidates from genuinely adjudicated `needs-context` verdicts in manifests.
- Make deep adjudication explicit-only, neutralize internal review terminology, and disable forensics by default.
- Add blind, provider-adaptable end-to-end harness evaluation and context-change/injection regression coverage.
