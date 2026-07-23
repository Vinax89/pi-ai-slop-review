# Pi AI-Slop Review

A conservative, read-only [Pi](https://pi.dev) extension for evidence-backed review of TypeScript, JavaScript, and Python changes.

## Install

Requires Node.js 22.5 or newer.

```bash
pi install npm:pi-ai-slop-review
```

Try it for one session without installing:

```bash
pi -e npm:pi-ai-slop-review
```

A version-tagged Git installation is also supported:

```bash
pi install git:github.com/Vinax89/pi-ai-slop-review@v1.1.0
```

Pi packages execute code with the user's privileges. Review the source and [`docs/security.md`](docs/security.md) before installation.

## Use

- `/slop-review` reviews files changed through tracked `edit`, `write`, or `ctx_edit` calls in the current Pi session.
- `/slop-review src/a.ts src/b.ts` reviews explicit project-relative files.
- `/slop-audit` explicitly runs repository-wide review; ordinary review remains change-scoped.
- `/slop-findings` opens the TUI finding picker; a finding ID prefix opens it directly.
- `/slop-timeline` shows content-hash-valid mutations and verification freshness.
- `/slop-claims <text>` checks deterministic completion claims against configured evidence.
- `/slop-context <symbol-or-path>` queries callers, tests, specifications, and public-surface context.
- `/slop-suppress`, `/slop-unsuppress`, and `/slop-feedback` manage reasoned local policy evidence.
- `/slop-rules` reports policy decisions and calibrated rule health.
- `/slop-export json|sarif [path]` exports the latest evidence; omitted paths use private extension state.
- `/slop-diagnostics` and `/slop-config` explain runtime, trust, provider, and configuration state.
- `/slop-lab` creates, validates, explicitly applies, or rolls back patch proposals. Validation uses separate baseline/candidate Git worktrees inside Bubblewrap with a separate network namespace, cleared environment, private HOME, and private `/tmp`.
- `/slop-experiment` runs bounded pure-expression property, metamorphic, shadow, mutation, invariant, regression-generation, equality-saturation, and CEGIS checks.
- `/slop-formal` runs explicitly enabled SMT expression equivalence or Alive2-compatible LLVM translation validation through allowlisted, network-isolated commands.
- `/slop-retrieve` ranks local graph context without uploading source. `/slop-critics` is an opt-in remote advisory panel whose non-abstaining responses must cite existing deterministic evidence IDs.
- The `slop_review`, `slop_context`, `slop_propose`, `slop_verify`, `slop_experiment`, `slop_formal`, `slop_retrieve`, and `slop_critics` tools expose the same capabilities to the agent. Agent tools never apply patches to the real checkout.

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

The extension never modifies reviewed code during review, installs dependencies, imports project modules, infers AI authorship from style, or automatically removes findings. Source application requires a verified laboratory run plus an explicit user `/slop-lab apply` confirmation and fresh source hashes; R3, file-deleting, and configured critical-path proposals are blocked. Network access, remote critics, formal engines, and project tool execution are disabled by default. Experimental results state their finite domains, semantics, assumptions, timeouts, and abstentions; sampled success or solver `unknown` is never called proof.

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
