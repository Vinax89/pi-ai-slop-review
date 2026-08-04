# Operations

## Runtime requirements

- Node.js 22.7 or newer; Node 24 is tested. The evaluation, benchmark, and test scripts use `--experimental-strip-types --experimental-transform-types`.
- Python 3.11–3.13 for Python AST and `tomllib` manifest analysis.
- Git for patch laboratories.
- Bubblewrap on Linux for patch/formal execution. Unsupported hosts abstain from those operations.

## Configuration

Global: `~/.pi/agent/ai-slop/config.json` or `PI_AI_SLOP_CONFIG`.

Project: `.pi/ai-slop.json`, read only when Pi trusts the project.

Network, LSP execution, validation commands, remote critics, SMT, and translation validation require explicit configuration. Validation/formal commands must match a configured `execution.commands` entry exactly; suffix arguments are not authorized. Restricted execution exposes system runtimes, the exact executable, declared worktrees/dependencies, and explicit temporary inputs—not the host root. `/slop-config` displays the effective non-secret configuration; `/slop-diagnostics` checks providers and stores.

## Lifecycle

From an extracted release directory:

```bash
node scripts/lifecycle.mjs install /path/to/release
node scripts/lifecycle.mjs update /path/to/new-release
node scripts/lifecycle.mjs disable
node scripts/lifecycle.mjs enable
node scripts/lifecycle.mjs status
node scripts/lifecycle.mjs uninstall
node scripts/lifecycle.mjs purge-state  # separate, destructive
```

Install/update copies to a staging directory, installs locked runtime dependencies with lifecycle scripts disabled, atomically swaps the target, and restores the previous target on failure. Uninstall preserves state unless `purge-state` is separately requested.

## Recovery

State JSON keeps an atomic backup and rejects revision conflicts. SQLite graph writes are transactional and may be deleted/rebuilt without losing source. Interrupted lab worktrees are removed on normal exit; if the host terminates abruptly, use `git worktree prune` after inspecting them.

## Validation

```bash
npm run build
npm test
npm run evaluate
npm run benchmark
npm audit --omit=dev
npm run validate
```
`npm run evaluate` and `npm run benchmark` refresh `artifacts/evaluation.json` and `artifacts/benchmark.json`; each artifact includes SHA-256 hashes of code, corpus, executable rules, full library, schemas, package metadata, effective config, and runtime metadata, plus Python/Node runtime coverage metadata for evaluation.
