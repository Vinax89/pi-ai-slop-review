# AI Verdict Acceptance — 2026-08-07

Manual acceptance run of `/skill:ai-slop-review` over the paired verdict corpus in `artifacts/verdict-corpus/`.

## Invocation

```text
pi --no-extensions --no-skills \
  -e /home/irvin/ai-slop/index.ts \
  --skill /home/irvin/ai-slop/skills/ai-slop-review/SKILL.md \
  --no-session --approve \
  --tools read,slop_review,slop_findings,slop_context,slop_intent \
  -p "/skill:ai-slop-review pair1-wrapper.ts pair2-fallback.ts pair3-swallow.ts pair4-duplicate.ts pair5-dependency.py"
```

Result: exit code 0; `Static scan: complete — 5 files, 20 candidates, 0 skipped`; `LLM adjudication: 20/20 candidates reviewed`, one verdict per finding ID.

## Acceptance pairs and observed verdicts

| Pair | Defective member (expected) | Observed | Legitimate member (expected) | Observed |
|---|---|---|---|---|
| 1 wrapper | private pass-through `normalize` (confirmed) | **confirmed** | exported deprecated `parseDocumentLegacy` (dismissed) | **dismissed** |
| 2 fallback | `loadFlags` silent `[]` fallback (confirmed) | **confirmed** | `loadLimits` documented typed default (dismissed) | not a candidate; detector correctly excluded |
| 3 swallow | `sync` empty catch (confirmed) | **confirmed** | `emitTelemetry` documented best-effort (dismissed) | not a candidate; detector correctly excluded |
| 4 duplicate | `first`/`initial` identical body + contract (confirmed) | **confirmed** | `truncateDisplay`/`truncateStorage` same body, separate documented contracts (dismissed) | **dismissed** |
| 5 dependency | undeclared `import requests` (confirmed) | **confirmed** | optional `orjson` import with degradation (dismissed) | not a candidate; detector correctly excluded |

Target-family verdicts: **8/8 correct**. All 12 `assurance.no-linked-tests` noise candidates were judged `needs-context`, which is the honest verdict given no local testing policy.

## Analysis

- No systematic detector failures; no detector or falsification-instruction changes required.
- Pair 4 required two-statement function bodies: the graph clone detector (`src/graph/provider.ts`) computes no `bodyHash` for single-statement bodies, so the duplicate pair was invisible in the first fixture attempt. The corpus files reflect the working shape.
- The verdicts exercised the full falsification ladder: exported compatibility API (dismissed), documented best-effort boundary (dismissed), separate contracts despite identical bodies (dismissed), undocumented silent fallback / empty catch / undeclared dependency / behavior-free private wrapper (confirmed).

## Re-running

```text
pi --no-extensions --no-skills -e /home/irvin/ai-slop/index.ts \
  --skill /home/irvin/ai-slop/skills/ai-slop-review/SKILL.md \
  --no-session --approve \
  --tools read,slop_review,slop_findings,slop_context,slop_intent \
  -p "/skill:ai-slop-review artifacts/verdict-corpus/pair1-wrapper.ts artifacts/verdict-corpus/pair2-fallback.ts artifacts/verdict-corpus/pair3-swallow.ts artifacts/verdict-corpus/pair4-duplicate.ts artifacts/verdict-corpus/pair5-dependency.py"
```

Expected counts: 5 files, 20 candidates, 3 rule families sampled for adjudication in repository mode, or all 20 in explicit mode (shown above).

## Consistency and ledger re-run — 2026-08-08

Two consecutive explicit-scope runs with the v1.4 toolchain (`slop_verdicts`, `slop_record_verdicts`, `slop_verify_verdicts`, report-only filtering):

- Run A: 8/20 candidates adjudicated (12 `assurance.no-linked-tests` report-only candidates omitted by default), verdicts recorded to the ledger.
- Run B: identical 8 verdicts on identical finding IDs, each marked `(unchanged from prior review)` — verdict stability across runs is now enforced and visible via the ledger's `same` classification.
- The model explicitly noted that the corpus comments ("expected: confirmed") were treated as untrusted data, not instructions — the adversarial-content rule in the skill fired as designed.

