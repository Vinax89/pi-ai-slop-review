# Experimental Verification

All experiments are advisory or proposal-gating. Unsupported domains abstain, timeout/unknown is never success, and no experiment applies source changes.

## Pure-expression engine

Supported grammar: finite numeric/boolean literals, declared variables, parentheses, unary `!`/`-`, arithmetic, comparisons, strict modeled equality, and boolean operators. No calls, properties, allocation, I/O, exceptions other than modeled division/modulo by zero, floating-point non-finite values, or side effects.

It provides:

- deterministic finite-domain property and shadow execution
- metamorphic relations over declared input transforms
- generated counterexamples and reviewable TypeScript regression tests
- output/error invariant comparison
- bounded operator mutation and mutation score
- fixed-point equality-class saturation for advisory simplification candidates
- counterexample-guided selection of a smaller expression

Only a fully exhausted declared finite domain may verify the bounded claim. Sampling and equality-saturation matches remain inconclusive even when they find no counterexample.

## SMT

The SMT adapter translates the supported integer/boolean expression subset to SMT-LIB, asserts non-equivalence, and invokes an exact configured solver command in network isolation. `unsat` verifies only the emitted model and assumptions; `sat` refutes with solver output; any other result is unknown.

## Translation validation

The translation adapter passes an explicit Alive2-compatible LLVM transformation to an exact configured validator command. Its verdict inherits the validator's LLVM memory and undefined-behavior model. Missing tools, unsupported IR, timeout, or ambiguous output abstains.

## Patch-lab amplification

A proposal may include expression experiments. Every experiment must verify for the lab run to verify. Ordinary validation also compares separate baseline/candidate command runs and public surfaces.

## Independent critics

Four roles independently seek support, counterexamples, behavioral issues, and test/security gaps. Responses are retained only as advisory context. A support/oppose response without a valid supplied evidence citation becomes abstention.
