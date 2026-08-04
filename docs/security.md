# Security and Privacy

## Trust boundaries

Reviewed repositories, source files, reports, LSP messages, registry responses, patches, model responses, and tool output are untrusted inputs.

## Safe defaults

- Read-only, changed-file review.
- Project-local configuration ignored until Pi trusts the project.
- Network disabled.
- LSP/project execution disabled.
- Remote critics and formal engines disabled.
- No dependency installation or project-module import.
- No shell interpolation.
- No automatic structural deletion or remediation.

## Filesystem controls

Paths are canonicalized and confined to the repository. Symlink escapes, non-regular mutation targets, oversized source/report files, unsafe patch paths, and exports outside the project are rejected. Repository discovery does not follow symlinks and excludes dependency/build directories.

## Process controls

LSP commands and validation commands use argument arrays with `shell: false`, output/time limits, and cancellation. Validation and formal tools accept only exact configured command arrays; an approved command cannot acquire extra arguments. LSP receives a reduced environment. Patch and formal validation use Bubblewrap without mounting the host root: only system runtime paths, the exact configured executable, explicit worktrees/dependency directories, and declared temporary inputs are visible. The process also receives separate network, PID, IPC, and UTS namespaces, a cleared environment, private HOME, and private `/tmp`. If the exact runtime, Bubblewrap, or trust is unavailable, validation abstains.

## Patch controls

Patch proposals record exact pre-validation hashes. Real application requires an explicit user command and confirmation, a successful current lab run, unchanged hashes, and a second `git apply --check`. R3, file-deleting, and configured critical-path proposals cannot be applied by the extension. Rollback is explicit and checked before execution.

## Model controls

Remote critics are opt-in and receive evidence summaries—not source bodies. Non-abstaining responses must cite existing deterministic evidence IDs. Critic agreement is not proof and cannot authorize action.

## Dependency provenance

Registry queries use fixed HTTPS npm, PyPI, and OpenSSF endpoints, bounded responses, redirects disabled, and explicit allowlisting. Provenance evidence never triggers package installation.
Evaluation artifacts are integrity-bound to SHA-256 hashes of code, corpus, executable rules, full library, schemas, package metadata, effective configuration, and runtime metadata; changing any input requires regenerating the artifact before using its metrics.

## Residual limitations

Static graphs cannot disprove reflection or dynamic registration. Tests cannot prove general equivalence. Bounded experiments apply only to their declared finite domain; sampled runs and equality saturation are advisory. LSP servers and exact configured project commands remain trusted-code execution and therefore require Pi project trust. Project dependency directories explicitly mounted for validation remain readable inside that isolated run.
