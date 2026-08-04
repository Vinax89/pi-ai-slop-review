# Rule Lifecycle

1. **Research:** record academic, standards, project-policy, and maintainer evidence in `library/sources.yaml`.
2. **Candidate:** define one falsifiable behavioral claim and known counterexamples.
3. **Observe:** implement candidate generation with C1 authority and no remediation.
4. **Verify:** add semantic/provider evidence, exact ranges/hashes, hard negatives, and repository-separated cases across train, validation, and holdout splits.
5. **Calibrate:** measure precision, abstention, reviewer outcomes, Wilson bounds, expected confidence, veto coverage, and unsafe actions.
6. **Propose:** permit a patch proposal only when the executable `rules.yaml` cap, evidence score, risk policy, counterevidence/veto expectations, and local health all permit it.
7. **Delegate safe fix:** reserved for an authoritative released analyzer's own low-risk fix and still requires project opt-in. No bundled rule currently has this authority.
8. **Demote/retire:** any unsafe action disables proposal authority; persistent low precision makes the rule observation-only or removes it.

Rule confidence and remediation proof are separate. Compiler certainty about a defect does not prove a particular repair. AI provenance never changes a rule's code-quality verdict.
