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
node --experimental-strip-types --test test/interfaces.test.ts test/packaging.test.ts
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

Published: `pi-ai-slop-review@1.3.0` is `latest` on the npm registry (maintainer `vinbitz`, 311.8 kB tarball, 138 files — `skills/ai-slop-review/SKILL.md` and `dist/src/isolated-scan.js` included, `artifacts/verdict-corpus/` excluded). Tarball: `https://registry.npmjs.org/pi-ai-slop-review/-/pi-ai-slop-review-1.3.0.tgz`. Publish required an interactive browser login plus 2FA OTP; the earlier `~/.npmrc` token was rejected (401/404).

## Feature batch (unreleased, candidate v1.4.0)

Eight improvement items from the post-release review, all implemented and verified:

1. **Verdict instability** — skill now biases toward `confirmed`/`dismissed` with explicit evidence-sufficiency thresholds (`needs-context` only as a last resort, not a hedge). Verified: two consecutive corpus runs produced identical verdicts for all 8 findings.
2. **Structured verdict submission** — `slop_submit_verdicts` validates the current scan ID and exact pending batch, derives canonical rule/location data, and persists at most 20 entries atomically.
3. **Context-aware verdict ledger** — stored verdicts carry an adjudication-context fingerprint and scan scope. `slop_verdicts` reports `new`, `reusable`, `context-changed`, `resolved`, and `not-observed/out-of-scope`; partial scans cannot resolve unseen findings.
4. **Confirm → propose chain** — skill wiring: fixes are proposed only through `slop_propose` (network-isolated worktree validation), never applied by the model; creation requires explicit user request.
5. **Delta-scoped repository audits** — `slop_review` accepts `delta: true` (repository scope): scans only files changed since git HEAD (`git diff --name-only` + `git ls-files -m -o`), falls back to a full audit without git. Verified: delta audit of a fixture scanned 1 changed file and ignored unchanged slop in another.
6. **Human-gated feedback conversion** — `/slop-verdict-feedback <id> [outcome]` converts a stored verdict into policy feedback only after an explicit `ctx.ui.confirm`; outcome defaults from the verdict (`confirmed`→`accepted`, `dismissed`→`intentional`, `needs-context`→`insufficient-evidence`).
7. **Adversarial repo content** — instructions embedded in scanned content are treated as data and ignored. Expected labels live outside the model-visible fixture source.
8. **Noise budget** — `assurance.no-linked-tests` is report-only: omitted from `slop_findings` queues by default (opt-in via `includeReportOnly`), count reported in the queue text. Corpus run dropped from 20 adjudicated candidates to 8, with coverage honestly reported as `8/20 candidates reviewed; 12 report-only test-assurance candidates omitted by default`.

Tests: `test/verdicts.test.ts` (6 new: parser, verifier, ledger record/classify, replacement, outcome mapping, report-only queue). `npm run validate` 172/172, actionable precision 1.0.

Published as v1.4.0 (commit `43e4679`, tag `v1.4.0`): `latest` on npm (322.6 kB tarball, 140 files, `dist/src/verdicts.js` + `skills/ai-slop-review/SKILL.md` included, fixtures excluded). Local `pi` install updated to 1.4.0; installed-package smoke in the default environment passed (delta audit + verdict carry-forward from the source-tree run, exit 0).

## Feature batch (unreleased, candidate v1.5.0)

Ten items from the v1.5 review, all implemented and verified:

1. **Validate flake hardening** — the one-off 171/172 failure never reproduced in 6 subsequent `validate` runs; code review found no shared-state race (all tests use isolated tmp state roots). The plausible mechanism was concurrent `dist` rebuilds: packaging tests ran `npm pack` (triggering `prepare` → `tsc`) while other test files ran. All three pack calls now use `--ignore-scripts` (dist is already built by `validate`'s build step), removing the contention source.
2. **Delta excludes deleted files** — `changedSinceHead` now parses `git diff --name-status -z` and drops `D` entries (renames handled, untracked included, non-source excluded, missing files filtered); moved to `src/core/discovery.ts` for testability.
3. **Delta honesty** — no readable git HEAD → explicit warning + labeled full-audit fallback; no supported changes since HEAD → returns "nothing to audit" without scanning. No more silent widening.
4. **Configurable report-only rules** — `rules.reportOnly` added to `AiSlopConfig` (default `["assurance.no-linked-tests"]`), merged/validated like other sections, documented in `schema/config.schema.json`.
5. **Batch finding retrieval** — `slop_findings` accepts `findingIds` (max 20) and returns all details in one call; skill guidance updated to fetch in batches.
6. **Skip unchanged verdict rewrites** — `recordVerdicts` skips records whose verdict/evidence/sourceHash are identical and keeps the original timestamp; returns the number actually written.
7. **Single `store.load()`** in `initialize()` (was two disk reads).
8. **Verdict manifest export** — `slop_verdicts` accepts `exportPath`; `writeVerdictManifest` writes an atomic JSON manifest (scanId, candidates, per-finding verdict/evidence/status, resolved count) for CI/PR consumption.
9. **Verdict stats** — `slop_verdicts` accepts `stats: true`; `verdictStats` aggregates per rule family (confirmed/dismissed/needs-context across reviews) — the calibration signal for tuning report-only defaults.
10. **Skill polish** — `full` passes `includeReportOnly: true`; coverage rules require naming omitted report-only candidates; batch guidance; acceptance doc counts updated.

Tests: 6 new (`report-only config merge`, `delta discovery x2`, `verdict stats`, `skip-unchanged re-record`, `verdict manifest`). `npm run validate` 178/178, actionable precision 1.0. Smokes: delta audit with a deleted file scanned only the changed source; empty delta returned "no supported source changes since git HEAD" without scanning; corpus run 8/20 with honest report-only coverage.

Published as v1.5.0 (commit `03b3071`, tag `v1.5.0`): `latest` on npm (325.9 kB tarball, 140 files). Local `pi` install updated to 1.5.0 via `pi install npm:pi-ai-slop-review@1.5.0` — note `pi update --extension` lags the registry metadata cache and did not pick up the new version; explicit-version install is the reliable upgrade path. Installed-package smoke in the default environment passed (exit 0; the evidence-sufficiency bias from v1.4 flipped a previously `needs-context` wrapper to `confirmed` with concrete evidence).

## Follow-up batch (unreleased, candidate v1.6.0)

- **Wired the dead `defaultScope` config** — it was declared, defaulted, validated, and in the schema but never read. `slop_review` now resolves an unscoped call to the configured default: `session` (existing behavior) or `repository` + delta when `defaultScope: "delta"` — and the skill's "otherwise" branch omits `scope` so the config applies. Verified end to end with `PI_AI_SLOP_CONFIG` + unscoped `/skill:ai-slop-review`: delta audit of 1 changed file, unchanged file untouched.
- **Report-only suggestions** — `slop_verdicts` accepts `suggestReportOnly`; `suggestReportOnlyRules` (verdicts.ts) flags rule families with ≥5 stored verdicts and ≥75% dismissal as advisory additions to `rules.reportOnly`. Pure function + 1 unit test.
- Skill scope text updated; README config example documents `defaultScope` and `rules.reportOnly`.

Tests: 179/179 (one new: report-only suggestion thresholds). `npm run validate` green.

Published as v1.6.0 (commit `3515978`, tag `v1.6.0`): `latest` on npm (326.9 kB tarball, 140 files). Local `pi` install updated via `pi install npm:pi-ai-slop-review@1.6.0` (first attempt failed on registry propagation; retry succeeded). Installed-package smoke in the default environment passed: unscoped `/skill:ai-slop-review` with `defaultScope: "delta"` in the config produced a delta audit of the one changed file, with the verdict ledger carried forward (`unchanged from prior review`), exit 0. Registry publish note: the npm browser-session token expires between sessions — `npm publish` 404s until a fresh `npm login`; run it first, then publish.

## Feature batch (unreleased, candidate v1.7.0)

1. **Release gate** — `scripts/release-check.mjs` (`npm run release:check`): fails with a clear "run `npm login`" on missing auth, asserts version consistency across package.json/shrinkwrap/README tag, runs `validate`, and verifies pack contents (SKILL.md, `dist/src/verdicts.js`, fixtures excluded). Verified passing end to end.
2. **`formatVerdictDelta` prefix fix** — extracted to `src/verdicts.ts`; with a `findingId` prefix, `resolved` entries are now filtered consistently instead of listing every resolved record.
3. **`delta: "since-audit"`** — repository audits scoped to files changed since the last audit baseline (mtime-based on previously scanned files + newly discovered files; works without git, requires a prior baseline). `changedSinceAudit` in `src/core/discovery.ts`. Verified end to end on a git-less fixture: full audit baseline → exactly the 2 changed/new files scanned, exit 0. Skill scope text documents `audit repository since-audit`.
4. **GitHub Actions CI** — `.github/workflows/validate.yml`: `npm ci` + `npm run validate` on push/PR, matrix node 22 + 24 (verified node 22.23.1 runs the suite).
5. **Detector regression hardening** — `structure.duplicate-capability` now extracts leading comments into graph node metadata and adds counterevidence "duplicate bodies carry separate documented contracts" when a clone group has distinct doc comments (unknown cleared accordingly). Two corpus cases added to `library/cases.jsonl`: identical multi-statement bodies → flag (waste_candidate, C1, observe); same-body distinct JSDoc contracts → hard negative with veto "separate documented contracts". Corpus: 33/33 pass, 0 unsafe actions.
6. **Corpus consistency re-run (v1.7)** — acceptance pairs re-run with the current skill: identical 8 finding IDs and identical verdict assignments (5 confirmed, 3 dismissed) to the v1.4/v1.5 runs; coverage `8/20 candidates reviewed; 12 report-only test-assurance candidates omitted by default`.

Tests: 181/181 (2 new since-audit, 2 new corpus cases, mock-veto mapping). `npm run validate` green; `npm run release:check` green.

Published as v1.7.0 (commit `bb71286`, tag `v1.7.0`): `latest` on npm (330.2 kB tarball, 141 files — now includes `scripts/release-check.mjs`). Local `pi` install updated via `pi install npm:pi-ai-slop-review@1.7.0`. Installed-package smoke in the default environment passed: `since-audit` on the git-less fixture scanned only the newly added file, reported the two prior findings as resolved via the ledger, exit 0. The publish flow confirmed the auth dance the release gate now catches: `npm whoami` succeeds with a stale session but publish needs a fresh `npm login` — the gate fails with exactly that message when auth is missing.

## Constraints to preserve

- No inferred AI authorship.
- No automatic source modification during review.
- No remote critic calls by default.
- No silent widening from session review to repository audit.
- No claim of complete LLM adjudication when findings were omitted.
- Keep scanner isolation and repository resource ceilings.
