# Pi AI-Slop Review v1 completion audit

Updated: 2026-07-23T18:01:26Z

## Scope and conclusion

This audit covers the v1 implementation in this package. The extension reviews concrete code-quality and assurance evidence; it does not infer AI authorship from style, metadata, names, comments, or architecture. Review is read-only and current-session scoped by default. Repository audit, project tools, network providers, critics, formal engines, and source application are explicit gated operations.

The implementation is versioned `1.2.0`. Development and verification used only isolated fixtures outside reviewed user repositories.

## Requirement-to-evidence map

| Requirement | Implemented evidence | Verification evidence |
| --- | --- | --- |
| Provenance separate from quality | `README.md`, `library/README.md`, `docs/architecture.md`, critic system prompt; no authorship score or style-based provenance field | corpus is provenance-blind; source search finds only explicit non-inference statements and dependency provenance |
| Versioned, hash-valid evidence | `src/types.ts`, `src/core/schema.ts`, `schema/scan-result.schema.json`; stable content-addressed evidence/finding/scan IDs and exact source hashes/ranges | foundation, TypeScript range, Python UTF-16, and export tests |
| Conservative provider/policy separation | `src/providers/provider.ts`, `src/providers/federation.ts`, `src/policy/engine.ts`, `library/rules.yaml` | policy, provider degradation, hard-negative, and malformed-input tests |
| Session assurance ledger | `src/core/ledger.ts`, branch/session entries in `index.ts`; mutation hashes, verification freshness, deterministic claims, baselines, and deltas | ledger tests cover success, failed checks, stale hashes, symlink escape, and stable deltas |
| Semantic native review | TypeScript `Program`/`TypeChecker` and resolver; isolated Python stdlib AST helper | TypeScript, Python, Python 3.11 grammar-floor, mixed-language, and false-positive regression tests |
| Provider federation | trusted LSP; SARIF; ESLint/Ruff/Pyright/Knip report adapters; LCOV/coverage.py; dependency provenance | malformed/oversized LSP, trust gates, scrubbed environment, SARIF escape, report normalization, malformed manifest, and network-off tests |
| Repository context | incremental `node:sqlite` graph for symbols, calls, imports, exports, tests, specifications, layers, framework/package entry points, clones, impact, and public-surface deltas | graph tests cover TypeScript, Python, manifests, malformed manifests, architecture, tests/specs, clones, and incremental signatures |
| Calibrated decisions | counterevidence vetoes, risk/action caps, suppressions, feedback, Wilson bounds, selective and conformal thresholds, abstention | policy and corpus tests; unsafe feedback disables authority |
| Reviewer interfaces | 18 slash commands, eight agent tools, TUI finding picker, diagnostics/config, context, weighted Markdown/JSON/SARIF export | interface unit tests plus fresh Pi RPC registration/review and TUI `select` smoke inspection |
| Guarded patch laboratory | separate baseline/candidate Git worktrees, Bubblewrap network namespace, scrubbed environment, private HOME/tmp, allowlisted argv execution, source hash guards, rollback | lab tests cover isolation, injection resistance, stale hashes, explicit application, rollback, deletion, R3, critical paths, and trust |
| Test amplification and bounded experiments | property/metamorphic/shadow checks, mutation score, regression generation, invariants, equality saturation, CEGIS, local retrieval, evidence-citing critics | experiment tests cover equivalence, counterexamples, unsupported syntax, citations, and repository-local retrieval |
| Dynamic/formal adapters | gated SMT expression-equivalence and Alive2-compatible LLVM translation validation with declared assumptions/timeouts and abstention | adapter tests use allowlisted isolated commands and verify bounded verdict parsing |
| Secure lifecycle and packaging | `scripts/lifecycle.mjs`, npm shrinkwrap, exact TypeScript pin, Pi package metadata, state-preserving uninstall and separate purge | lifecycle unit test and packed install/disable/enable/update/uninstall smoke; registry signature/attestation audit |
| Evaluation and performance | repository-separated train/validation/holdout corpus and deterministic 40-file benchmark | `artifacts/evaluation.json`, `artifacts/benchmark.json`, and `artifacts/self-scan.json` |
| Documentation and operations | architecture, security, experiments, evaluation, rule lifecycle, operations, evidence library, configuration and result schemas | package dry-run includes runtime, library, docs, schemas, evidence artifacts, shrinkwrap, and lifecycle script |

## Fresh final gates

The completion run executes these gates after the last source change:

```text
npm run validate
npm run benchmark
npm audit signatures
python3 -I -S -m py_compile src/python_helper.py src/python_graph_helper.py src/python_common.py
npm pack --dry-run --json
packed lifecycle install -> disable -> enable -> update -> uninstall
Pi RPC mixed TypeScript/Python review and command registration
Pi RPC TUI finding-picker rendering
repository-wide self-scan
host-repository isolation inspection
```

Machine-readable generated evidence is retained in `artifacts/evaluation.json`, `artifacts/benchmark.json`, and `artifacts/self-scan.json`.

## Residual self-observations

The self-scan is not forced to report a clean tree. Observation-only catch-boundary findings remain visible where the implementation intentionally fails closed or degrades optional protocol capability: project-file decoding/reading and unsupported LSP shutdown, pull-diagnostic, or symbol operations. These observations do not authorize proposals. Unreadable/corrupt policy state, dependency manifests, lockfiles, graph metadata, mutation files, and package manifests now produce explicit diagnostics or hard failures rather than silent clean evidence. The exact final counts and provider statuses are in `artifacts/self-scan.json`.

## Bounded claims

- The bundled corpus is regression evidence, not population-level accuracy.
- Sampled expression checks are bounded evidence, not universal proofs.
- Solver `unknown`, timeout, unsupported semantics, missing Bubblewrap, absent language servers, or malformed provider output causes abstention/degradation, never stronger authority.
- Formal engines and third-party analyzers are adapters; the extension does not install them.
- Remote critics are advisory and cannot authorize remediation.
- The package is private and unlicensed by design; lifecycle installation from an explicitly selected local package is supported. Public registry publication is not claimed.
