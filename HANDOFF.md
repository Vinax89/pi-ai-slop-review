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

## Resolved

### 1. Non-interactive Pi shutdown

Root cause: the reusable scan worker is a `fork()` child whose IPC pipe is a separate ref'd handle — `ChildProcess.unref()` unrefs the process handle but not the pipe, so an idle worker kept `pi -p`'s event loop alive after the model response.

Fix: `ScanTransport.unref()`/`ref()` (`src/isolated-scan.ts`) also unref/ref `child.channel`. Reuse is unchanged while the parent lives; when the loop drains, the process exits and the pipe dies with it, so no orphaned child remains.

Verified:

- Real skill smoke (`pi --no-extensions --no-skills -e index.ts --skill …/SKILL.md --no-session --approve -p "/skill:ai-slop-review input.ts"`): full response emitted, exit code 0, no worker orphan.
- Regression test `an idle isolated worker does not keep the parent process alive` (spawns a process that scans without `resetIsolatedScanWorker`); fails with SIGTERM timeout without the fix, passes with it.
- Worker reuse intact: cache-hit/reuse tests in `test/scan.test.ts` still pass (16/16); full `npm run validate` 166/166, actionable precision 1.0.

### 2. Disambiguate verdict output

Every verdict line now starts with the finding's exact ID, rule ID, and location as returned by `slop_findings`:

```text
finding:da09abeeb313a9da9854dd2f | data.hidden-catch-fallback | input.ts:31:5 — Whether `{}` is an intentional optional-config fallback or masks required configuration errors.
```

Changes:

- `skills/ai-slop-review/SKILL.md` Output section: verdict format `finding ID | rule ID | path:line`, one verdict line per finding ID (verbatim ID, never a prefix), no merging of same-location findings, no verdicts for unreviewed candidates, and a pre-coverage recount rule (verdict lines must equal adjudicated IDs).
- `index.ts` `findingDetails()`: the ID tuple now leads each finding detail (`id | ruleId | path:line | confidence`), mirroring the queue format so the model copies exact IDs.

Verified with the real skill smoke: 8 verdict lines, 8 unique IDs, 8/8 adjudicated, exit code 0; full `npm run validate` 166/166, actionable precision 1.0. Skill prose is intentionally not unit-tested.

### 3. Exercise repository scope through the skill

Confirmed with `/skill:ai-slop-review audit repository` on a small fixture repo (4 files, 6 candidates, 3 families) and on this repository itself (86 files, 17 candidates, 3 families):

- `slop_review` uses repository mode with bounded discovery; scan line matches ground truth (`Static scan: complete — N files, Y candidates, 0 skipped`).
- `slop_findings` returns one highest-ranked representative per rule family (tool behavior covered by `test/interfaces.test.ts`).
- Coverage is reported as representative coverage.

The first real-repo run exposed a skill gap: the model ignored the representatives default and adjudicated 17/17 candidates (200 s run). `SKILL.md` was tightened:

- Workflow step 3 now makes `representatives: true` mandatory for repository scope without `full` — "never page through the full ranked queue".
- Output format rules now require the adjudication line `N/M rule-family representatives (of Y static candidates)` for repository scope, never presenting representative coverage as full coverage.

After the tightening, both fixture and real repo produce exactly one verdict per family (3 verdicts, `3/3 rule-family representatives (of 17 static candidates) reviewed`) and the real-repo run dropped from 200 s to 62 s.

### 4. Evaluate AI verdict quality

Accepted. Paired corpus committed at `artifacts/verdict-corpus/` (5 pairs, both members per file); the run record is `artifacts/verdict-acceptance.md`.

Single explicit-scope skill run over all five pairs: 5 files, 20 candidates, 20/20 adjudicated, one verdict per ID, exit code 0. Target-family verdicts 8/8 correct:

- private pass-through wrapper → confirmed; exported deprecated compatibility wrapper → dismissed;
- silent `[]` fallback → confirmed; documented typed fallback → correctly not a candidate;
- empty catch → confirmed; documented best-effort telemetry → correctly not a candidate;
- identical-body/identical-contract exports → confirmed; same-body separate documented contracts → dismissed;
- undeclared `import requests` → confirmed; optional `orjson` import → correctly not a candidate.

All 12 `assurance.no-linked-tests` noise candidates were judged `needs-context` (honest absent a local testing policy). No systematic detector failures, so no detector or falsification changes were made.

One detector behavior surfaced: the graph clone detector (`src/graph/provider.ts`) skips single-statement bodies (no `bodyHash`), so duplicate pairs need multi-statement bodies to be flagged — the corpus files reflect that shape.

## Release status (2026-08-08)

Workflow accepted; v1.3.0 prepared and committed (commit `7f21bca`, tag `v1.3.0` pushed to origin):

- version bumped 1.2.5 → 1.3.0 (`package.json`, `npm-shrinkwrap.json`, README git-install tag);
- `npm run validate` 166/166, actionable precision 1.0;
- `npm pack --dry-run --json` confirmed `skills/ai-slop-review/SKILL.md` ships and `artifacts/verdict-corpus/` fixtures are excluded (`!artifacts/verdict-corpus` in the `files` whitelist).

`npm publish` is blocked on registry credentials: the token in `~/.npmrc` is not accepted for the `vinbitz` maintainer account (`npm whoami` → 401, publish PUT → 404). Unblock: `npm login` as the maintainer or install a valid automation token, then run `npm publish` from a clean checkout at `v1.3.0`.

## Constraints to preserve

- No inferred AI authorship.
- No automatic source modification during review.
- No remote critic calls by default.
- No silent widening from session review to repository audit.
- No claim of complete LLM adjudication when findings were omitted.
- Keep scanner isolation and repository resource ceilings.
