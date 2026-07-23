# Architecture

Pi AI-Slop Review is an evidence federation and verification extension. It reports concrete defects, context conflicts, assurance gaps, review externalities, and narrowly supported waste candidates. It never infers AI authorship from coding style.

## Data flow

1. Pi `tool_call` and `tool_result` hooks record content-hash-valid mutations and configured verification runs.
2. Session or explicit paths enter the native TypeScript and isolated Python scanners.
3. Trusted/configured LSP, SARIF, analyzer-report, coverage, dependency-provenance, and repository-graph providers add independent evidence.
4. The policy engine loads executable limits from `library/rules.yaml`, searches for counterevidence, applies hard risk/action caps, checks local suppressions and rule health, and abstains when evidence is insufficient.
5. Commands, tools, TUI entries, JSON, and SARIF expose the result.
6. Patch proposals execute only in separate baseline and candidate Git worktrees. Validation commands run in Bubblewrap with a separate network namespace, cleared environment, private HOME, and private `/tmp`.

## Persistence

- Pi custom session entries: branch-aware assurance ledger and rendered reviews.
- `~/.pi/agent/ai-slop/state/<repository-id>/state.json`: baselines, suppressions, feedback, proposals, and lab summaries.
- `~/.pi/agent/ai-slop/graph/<repository-id>/context.sqlite`: content-hash-invalidated graph facts.
- Exported source text is not stored by ordinary review. Explicit patch proposals necessarily store their user-supplied patch in private extension state.

State writes use revision checks, a lock file, an atomic rename, and a previous-version backup. SQLite updates are transactional.

## Provider authority

Provider evidence retains provider ID, version, source hash, range, and strength. External analyzer fixes are evidence only. Unknown rules are capped at C2/observe. Counterevidence, R3 risk, unhealthy feedback, or insufficient calibrated evidence can only reduce authority.

## Repository graph

The graph records files, symbols, imports, calls, exports, tests, coverage edges, requirements, specifications, framework registrations, package entry points, and dependencies. TypeScript uses the compiler checker and resolver. Python uses `ast` under `python -I -S`. Markdown and manifests are parsed as data. Incremental updates replace all facts for one changed content hash transactionally.

## Default modes

- Review: current-session changed files.
- Audit: explicit repository-wide discovery.
- Lab: explicit isolated patch validation.
- Formal/critics/network providers: explicit configuration plus feature gates.
