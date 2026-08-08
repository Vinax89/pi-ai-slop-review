# Pi AI-Slop Review

A skill-first Pi package for evidence-backed LLM review of TypeScript, JavaScript, and Python changes, backed by a conservative deterministic extension.

## Requirements

Requires Node.js 22.7 or newer because the package's TypeScript entry points use Node's type stripping and type transformation runtime flags. Node 24 is tested.

The Pi TUI, TypeBox, and optional critic API integrations are declared as optional peer modules. The package entrypoint can be inspected or imported without those host peers; the Pi integration loads its UI/schema peers only when the extension factory runs, and critic support reports a clear missing-peer error only when `/slop_critics` is invoked.

```bash
pi install npm:pi-ai-slop-review
```

Try it for one session without installing:

```bash
pi -e npm:pi-ai-slop-review
```

A version-tagged Git installation is also supported:

```bash
pi install git:github.com/Vinax89/pi-ai-slop-review@v1.4.0
```

Pi packages execute code with the user's privileges. Review the source and [`docs/security.md`](docs/security.md) before installation.

## Use

Use the bundled skill when the active Pi model should inspect and adjudicate detector candidates:

```text
/skill:ai-slop-review
/skill:ai-slop-review src/a.ts src/b.ts
/skill:ai-slop-review audit repository
/skill:ai-slop-review audit repository full
```

The skill makes the current Pi model the decision engine: it runs the bounded scanner, reads each selected finding and its source, traces callers and contracts, tries to falsify the claim, and reports `confirmed`, `dismissed`, or `needs-context`. It reports static-scan and LLM-adjudication coverage separately and never infers AI authorship. Explicit `/skill:ai-slop-review` invocation guarantees the workflow is loaded; automatic skill selection remains model-dependent.

Raw extension commands remain available for deterministic scanning, state, and diagnostics:

- `/slop-review` reviews files changed through tracked `edit`, `write`, or `ctx_edit` calls in the current Pi session.
- `/slop-review src/a.ts src/b.ts` reviews explicit project-relative files.
- `/slop-audit` explicitly runs repository-wide review of up to 10,000 supported files by default; native TypeScript scans and repository-graph extraction use programs bounded to 250 files and 4 MiB of root source, and Python graph helpers retry oversized output in smaller bounded batches.
- Every review or audit runs in a reusable isolated child process with a 384 MiB old-generation limit; streamed content hashes identify unchanged requests without a second result copy, garbage collection runs only under heap pressure, and recycled processes reuse Node's native compile cache. Results report `complete`, `partial`, or `abstained`; process failure or memory-limit exit becomes `abstained` instead of terminating Pi. The private Markdown report states whether any code change is supported, separates actionable proposals from detector hypotheses, and provides a representative-review queue for calibration. Feedback applies only to the named finding, never an entire family. Linked tests, callers, and specifications are named when available. The complete candidate set remains available through `/slop-findings`, JSON, and SARIF.
- `/slop-findings` opens the TUI finding picker; a finding ID prefix opens it directly.
- `/slop-triage` summarizes evidence, counterevidence, uncertainty, and human-review guidance; findings are never treated as proof that code is removable.
- `/slop-timeline` shows content-hash-valid mutations and verification freshness.
- `/slop-claims <text>` checks deterministic completion claims against configured evidence.
- `/slop-context <symbol-or-path>` queries callers, tests, specifications, and public-surface context.
- The `slop_intent` tool builds an evidence-cited decision trace plus paper-derived dimensions (relevance, factuality, density, repetition, templatedness, coherence, and tone). It accepts an optional artifact/task/audience review profile; unknown dimensions remain unknown, the LLM interprets the evidence, and a human makes the final determination.
- `slop_intent` can compute bounded local text/code forensics when `includeForensics` is enabled (default): a model-free document-bigram perplexity proxy, sentence/line burstiness, argument dependency, falsifiable-claim and jargon rates, section interchangeability, repetition and boilerplate rates, logic-density rates, and a local stylometric fingerprint. `calibrateProjectSignals` accepts caller-supplied source-hash-linked history for descriptive density drift; it does not read Git history or label automation.
- `slop_provenance` verifies bounded project-local artifact hashes and Ed25519-signed provenance manifests against configured trust keys, then checks explicitly linked cross-modal descriptors for missing links, timestamp mismatches, and caption inconsistencies. Trusted provenance supports origin assertions but does not prove authorship or synthetic generation.
- `slop_clusters` analyzes caller-supplied offline publishing or repository events for synchronized shared hashes/templates and reports domain-level repetition patterns. It performs no network collection, account termination, or automatic downranking.
- Full vendor C2PA profile coverage, SynthID detection, generator-specific neural classifiers, and platform-scale S-CTS coordination remain unsupported until explicit media-ingestion, detector, reference-corpus, and network-evidence contracts exist.
- `/slop-suppress`, `/slop-unsuppress`, and `/slop-feedback` manage reasoned local policy evidence.
- `/slop-rules` reports policy decisions and calibrated rule health.
- `/slop-export markdown|json|sarif [path]` exports the latest evidence; omitted paths use private extension state.
- `/slop-diagnostics` and `/slop-config` explain runtime, trust, provider, and configuration state.
- `/slop-lab` creates, validates, explicitly applies, or rolls back patch proposals. Validation uses exact configured commands in separate baseline/candidate Git worktrees inside Bubblewrap with no host-root mount, a separate network namespace, cleared environment, private HOME, and private `/tmp`.
- `/slop-experiment` runs bounded pure-expression property, metamorphic, shadow, mutation, invariant, regression-generation, equality-saturation, and CEGIS checks.
- `/slop-formal` runs explicitly enabled SMT expression equivalence or Alive2-compatible LLVM translation validation through exact configured, network-isolated commands.
- `/slop-retrieve` ranks local graph context without uploading source. `/slop-critics` is an opt-in remote advisory panel whose non-abstaining responses must cite existing deterministic evidence IDs.
- The `slop_review`, `slop_findings`, `slop_context`, `slop_intent`, `slop_verdicts`, `slop_record_verdicts`, `slop_verify_verdicts`, `slop_provenance`, `slop_clusters`, `slop_propose`, `slop_verify`, `slop_experiment`, `slop_formal`, `slop_retrieve`, and `slop_critics` tools expose the same capabilities to the agent. `slop_review` accepts session, explicit-path, or repository scope, plus `delta` for a git-HEAD-scoped repository audit; `slop_findings` provides stable IDs, bounded pagination, one representative per detector family, and omits report-only families (`assurance.no-linked-tests`) unless requested. `slop_verdicts`/`slop_record_verdicts` maintain a review-history ledger that later reviews classify as new/same/stale/resolved; `slop_verify_verdicts` enforces the verdict output contract. `/slop-verdict-feedback` converts a stored verdict into policy feedback only after an explicit human confirmation. Agent tools never apply patches to the real checkout.

The scanner federates a TypeScript `Program`/`TypeChecker`, an isolated Python stdlib AST helper, explicitly trusted language servers, SARIF 2.1, ESLint/Ruff/Pyright/Knip reports, LCOV/coverage.py reports, and local dependency provenance. It reports:

- unresolved modules
- simple pass-through wrapper candidates
- empty or log-only catch clauses
- catch clauses returning safe-looking fallbacks

Python wrapper findings remain observation-only because repository-wide dynamic references are not proven. Python imports guarded by `TYPE_CHECKING`, `ImportError`, or platform conditions are excluded. External analyzer fixes are retained only as evidence.

Optional global configuration lives at `~/.pi/agent/ai-slop/config.json`. A project may provide `.pi/ai-slop.json`, but Pi ignores it until the project is explicitly trusted. Example:

```json
{
  "schemaVersion": 1,
  "execution": {
    "trusted": true,
    "lspServers": { "typescript": ["typescript-language-server", "--stdio"] }
  },
  "providers": {
    "sarif": ["reports/results.sarif"],
    "analyzerReports": [{ "kind": "eslint", "path": "reports/eslint.json" }],
    "coverageReports": [{ "kind": "lcov", "path": "coverage/lcov.info" }]
  }
}
```

The extension never installs a missing language server or scanner. LSP startup requires both Pi project trust and `execution.trusted`. Registry requests require `network.enabled` plus an allowlisted registry (`npm`, `pypi`, or `openssf`).

The extension keeps a branch-aware assurance ledger in Pi session entries and stores review baselines outside the repository under `~/.pi/agent/ai-slop/state/`. Verification is authoritative only when configured, and becomes stale when relevant content hashes change. Project-local `.pi/ai-slop.json` configuration is ignored until Pi explicitly trusts the project.

An incremental SQLite context graph under `~/.pi/agent/ai-slop/graph/` records TypeScript and Python symbols, resolved calls/imports, public exports, framework registrations, package entry points, tests, coverage links, Markdown requirements, and specification links. It supplies public-surface changes, architecture-policy conflicts, exact-body clone observations, and test-impact evidence without storing source bodies.

The extension never modifies reviewed code during review, installs dependencies, imports project modules, infers AI authorship from style, or automatically removes findings. Source application requires a verified laboratory run plus an explicit user `/slop-lab apply` confirmation and fresh source hashes; R3, file-deleting, and configured critical-path proposals are blocked. Network access, remote critics, formal engines, and project tool execution are disabled by default. Experimental results state their finite domains, semantics, assumptions, timeouts, and abstentions; equality saturation is advisory, and only an exhausted declared domain—not sampled success or solver `unknown`—can verify a bounded expression experiment.

## Development and validation

```bash
npm install
npm run build
npm test
npm run evaluate
npm run benchmark
npm audit --omit=dev
npm run validate
```

Generated evaluation and performance evidence is written under `artifacts/`. The evidence library is in `library/`.

## Documentation

- [`docs/architecture.md`](docs/architecture.md)
- [`docs/security.md`](docs/security.md)
- [`docs/experiments.md`](docs/experiments.md)
- [`docs/evaluation.md`](docs/evaluation.md)
- [`docs/rule-lifecycle.md`](docs/rule-lifecycle.md)
- [`docs/operations.md`](docs/operations.md)
