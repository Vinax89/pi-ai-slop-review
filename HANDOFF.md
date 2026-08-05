# AI-Slop Review Handoff

## Objective

Make `pi-ai-slop-review` useful as an AI-led code review rather than a raw static-finding dump, while preserving deterministic scanning, memory isolation, evidence, and conservative change authority.

## Current state

The worktree contains two connected changesets:

1. Scanner/actionability repairs from the original heap-exhaustion and false-positive investigation.
2. A new skill-first workflow in which the active Pi model adjudicates deterministic candidates.

All source changes are included in the accompanying commit. `.pi-glla/` is local agent state and is intentionally not committed.

## Implemented

### Memory and scan behavior

- TypeScript project work is bounded and batched instead of retaining one unbounded repository program.
- Repository graph extraction streams/persists fact batches rather than keeping the aggregate in memory.
- Python graph extraction retries oversized helper output in smaller batches.
- Repository graph review pages nodes and suppresses trivial test/migration clone groups.
- Expected generated/vendor exclusions no longer make an otherwise complete scan appear partial.

Relevant files: `src/typescript-scanner.ts`, `src/graph/build.ts`, `src/graph/provider.ts`, `src/core/completeness.ts`.

### Detector actionability

- TypeScript import resolution distinguishes runtime builtins, existing relative resources, and unresolved packages.
- Python dependency resolution covers project roots, declared requirements, import/distribution aliases, and PEP 723 inline metadata.
- Python wrapper/catch heuristics exclude tests, self-checks, public contracts, loop control, predicate outcomes, explicitly documented best-effort boundaries, typed errors, and optional/platform imports.
- Human feedback now applies to the exact source hash instead of broadly suppressing a family.
- Reports expose one representative review per family and explicitly state that unreviewed members remain open.

Relevant files: `src/python_helper.py`, `src/python_graph_helper.py`, `src/policy/engine.ts`, `src/export.ts`, `src/report.ts`, `src/types.ts`.

### Skill-first AI workflow

- Added `skills/ai-slop-review/SKILL.md` and declared it in `package.json`.
- The active Pi model is explicitly the decision engine; the scanner only supplies candidates.
- Skill verdicts are `confirmed`, `dismissed`, or `needs-context` after source, caller, contract, intent, and focused-check review.
- Static-scan coverage and LLM-adjudication coverage are reported separately.
- Default repository review uses one representative per rule family; `full` requests paged review of all findings.
- The skill does not invoke the four-model `slop_critics` panel unless the user explicitly asks.
- The skill never infers AI authorship and never changes code without an explicit request.

### Agent tool contracts

- `slop_review` now accepts `scope: "session" | "repository"`; explicit `paths` take precedence.
- Repository scope reuses bounded discovery and existing partial/completeness behavior.
- Added `slop_findings` for exact finding lookup, ranked pagination, stable IDs, and one representative per rule family.
- Added `createFindingQueue()` in `src/report.ts` so pagination and representative selection have behavior tests.

Relevant files: `index.ts`, `src/report.ts`, `test/interfaces.test.ts`, `test/packaging.test.ts`.

### Documentation

`README.md` now leads with:

```text
/skill:ai-slop-review
/skill:ai-slop-review src/a.ts src/b.ts
/skill:ai-slop-review audit repository
/skill:ai-slop-review audit repository full
```

Raw `/slop-review` and `/slop-audit` commands remain deterministic scanner interfaces.

## Verification completed

### Focused

```text
npm run typecheck
node --experimental-strip-types --experimental-transform-types --test test/interfaces.test.ts test/packaging.test.ts
```

Result: 18/18 focused tests passed.

### Complete

```text
npm run validate
```

Result:

- Build/typecheck/compiled distribution passed.
- 165/165 tests passed.
- Evaluation corpus: 31/31 passed.
- Actionable precision: 1.0.
- Unsafe hard-negative actions: 0.
- `npm audit --omit=dev` passed.

### Real Pi skill smoke

Fixture: `/tmp/pi-ai-slop-skill-smoke/input.ts` (not committed).

Successful invocation after disabling the already-installed older package to avoid duplicate tool names:

```text
pi --no-extensions --no-skills \
  -e /home/irvin/ai-slop/index.ts \
  --skill /home/irvin/ai-slop/skills/ai-slop-review/SKILL.md \
  --no-session --approve \
  --tools read,slop_review,slop_findings,slop_context,slop_intent \
  -p "/skill:ai-slop-review input.ts"
```

Observed model result:

- Static scan complete: 1 file, 7 candidates, 0 skipped.
- LLM adjudication: 7/7.
- The model dismissed the exported public wrapper and the documented best-effort telemetry catch.
- The hidden JSON fallback and private wrapper remained `needs-context` rather than being auto-fixed.

The process emitted the complete response but did not exit before the run was cancelled. Treat non-interactive shutdown as the first remaining issue.

## Remaining work

### 1. Fix non-interactive Pi shutdown

The local extension uses a reusable isolated scan worker. Determine whether that worker keeps `pi -p` alive after the model response. Add the smallest lifecycle cleanup only if reproduced; do not disable worker reuse for interactive sessions.

### 2. Disambiguate verdict output

The smoke response listed multiple candidates at the same source line without IDs/rule names. Update the skill output contract so every verdict includes:

```text
finding ID | rule ID | path:line
```

Enforce exactly one verdict per finding ID. This matters when graph and AST providers report different claims at the same location.

### 3. Exercise repository scope through the skill

Run `/skill:ai-slop-review audit repository` on a small fixture and then a real repository. Confirm:

- `slop_review` uses repository mode.
- `slop_findings` returns one highest-ranked representative per rule family by default.
- Reported LLM coverage is representative coverage, not falsely `N/N` over all static candidates.

### 4. Evaluate AI verdict quality

Add a small manual acceptance corpus with paired cases:

- private redundant wrapper vs exported compatibility wrapper;
- hidden fallback vs typed/intentional fallback;
- swallowed error vs documented best-effort boundary;
- true duplicate implementation vs same-body separate contracts;
- missing dependency vs optional/platform/inline-declared dependency.

Do not unit-test skill prose. Run the skill and record observed verdicts. Change deterministic detectors only when failures are systematic; otherwise refine the falsification instructions.

### 5. Release preparation

If the workflow is accepted:

- bump the package minor version;
- update the Git installation example/tag in `README.md`;
- run `npm run validate` again;
- inspect `npm pack --dry-run --json` for `skills/ai-slop-review/SKILL.md`;
- publish only after the non-interactive shutdown behavior is understood.

## Constraints to preserve

- No inferred AI authorship.
- No automatic source modification during review.
- No remote critic calls by default.
- No silent widening from session review to repository audit.
- No claim of complete LLM adjudication when findings were omitted.
- Keep scanner isolation and repository resource ceilings.
