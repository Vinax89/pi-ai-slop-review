import { fingerprint } from "../core/schema.ts";
import { SCHEMA_VERSION, type ExperimentResult, type ExperimentSpec, type ExperimentVariable } from "../types.ts";

type Value = number | boolean;
type Expression =
  | { kind: "literal"; value: Value }
  | { kind: "identifier"; name: string }
  | { kind: "unary"; operator: "!" | "-"; operand: Expression }
  | { kind: "binary"; operator: string; left: Expression; right: Expression };

interface Token {
  kind: "number" | "identifier" | "operator" | "left" | "right" | "eof";
  value: string;
}

const PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    const number = rest.match(/^(?:\d+(?:\.\d+)?|\.\d+)/);
    if (number) {
      tokens.push({ kind: "number", value: number[0] });
      index += number[0].length;
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier) {
      tokens.push({ kind: "identifier", value: identifier[0] });
      index += identifier[0].length;
      continue;
    }
    const operator = rest.match(/^(?:&&|\|\||==|!=|<=|>=|[+\-*/%<>!])/);
    if (operator) {
      tokens.push({ kind: "operator", value: operator[0] });
      index += operator[0].length;
      continue;
    }
    if (rest[0] === "(") tokens.push({ kind: "left", value: "(" });
    else if (rest[0] === ")") tokens.push({ kind: "right", value: ")" });
    else throw new Error(`unsupported expression token at offset ${index}`);
    index += 1;
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

class Parser {
  private index = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): Expression {
    const expression = this.binary(0);
    if (this.current().kind !== "eof") throw new Error(`unexpected token '${this.current().value}'`);
    return expression;
  }

  private binary(minimumPrecedence: number): Expression {
    let left = this.prefix();
    while (this.current().kind === "operator" && (PRECEDENCE[this.current().value] ?? -1) >= minimumPrecedence) {
      const operator = this.current().value;
      const precedence = PRECEDENCE[operator];
      this.index += 1;
      const right = this.binary(precedence + 1);
      left = { kind: "binary", operator, left, right };
    }
    return left;
  }

  private prefix(): Expression {
    const token = this.current();
    if (token.kind === "operator" && (token.value === "!" || token.value === "-")) {
      this.index += 1;
      return { kind: "unary", operator: token.value, operand: this.prefix() };
    }
    if (token.kind === "number") {
      this.index += 1;
      return { kind: "literal", value: Number(token.value) };
    }
    if (token.kind === "identifier") {
      this.index += 1;
      if (token.value === "true" || token.value === "false") return { kind: "literal", value: token.value === "true" };
      return { kind: "identifier", name: token.value };
    }
    if (token.kind === "left") {
      this.index += 1;
      const expression = this.binary(0);
      if (this.current().kind !== "right") throw new Error("missing closing parenthesis");
      this.index += 1;
      return expression;
    }
    throw new Error(`unexpected token '${token.value}'`);
  }

  private current(): Token {
    return this.tokens[this.index];
  }
}

function parse(source: string): Expression {
  return new Parser(tokenize(source)).parse();
}

type ExpressionType = "number" | "boolean";

function expressionType(
  expression: Expression,
  variables: Map<string, ExperimentVariable["type"]>,
  resultType?: ExpressionType,
): ExpressionType {
  if (expression.kind === "literal") return typeof expression.value === "boolean" ? "boolean" : "number";
  if (expression.kind === "identifier") {
    if (expression.name === "result") {
      if (!resultType) throw new Error("result is only valid in a property expression");
      return resultType;
    }
    const type = variables.get(expression.name);
    if (!type) throw new Error(`unknown variable '${expression.name}'`);
    return type === "boolean" ? "boolean" : "number";
  }
  if (expression.kind === "unary") {
    const operand = expressionType(expression.operand, variables, resultType);
    if (expression.operator === "!" && operand !== "boolean") throw new Error("! expects a boolean");
    if (expression.operator === "-" && operand !== "number") throw new Error("unary - expects a number");
    return operand;
  }
  const left = expressionType(expression.left, variables, resultType);
  const right = expressionType(expression.right, variables, resultType);
  if (expression.operator === "&&" || expression.operator === "||") {
    if (left !== "boolean" || right !== "boolean") throw new Error(`${expression.operator} expects booleans`);
    return "boolean";
  }
  if (["+", "-", "*", "/", "%"].includes(expression.operator)) {
    if (left !== "number" || right !== "number") throw new Error(`${expression.operator} expects numbers`);
    return "number";
  }
  if (["<", "<=", ">", ">="].includes(expression.operator)) {
    if (left !== "number" || right !== "number") throw new Error(`${expression.operator} expects numbers`);
    return "boolean";
  }
  if (expression.operator === "==" || expression.operator === "!=") {
    if (left !== right) throw new Error(`${expression.operator} expects operands of the same type`);
    return "boolean";
  }
  throw new Error(`unsupported operator '${expression.operator}'`);
}

function evaluate(expression: Expression, environment: Record<string, Value>): Value {
  if (expression.kind === "literal") return expression.value;
  if (expression.kind === "identifier") {
    if (!(expression.name in environment)) throw new Error(`unknown variable '${expression.name}'`);
    return environment[expression.name];
  }
  if (expression.kind === "unary") {
    const value = evaluate(expression.operand, environment);
    if (expression.operator === "!") {
      if (typeof value !== "boolean") throw new Error("! expects a boolean");
      return !value;
    }
    if (typeof value !== "number") throw new Error("unary - expects a number");
    return -value;
  }
  const left = evaluate(expression.left, environment);
  if (expression.operator === "&&") {
    if (typeof left !== "boolean") throw new Error("&& expects booleans");
    if (!left) return false;
    const right = evaluate(expression.right, environment);
    if (typeof right !== "boolean") throw new Error("&& expects booleans");
    return right;
  }
  if (expression.operator === "||") {
    if (typeof left !== "boolean") throw new Error("|| expects booleans");
    if (left) return true;
    const right = evaluate(expression.right, environment);
    if (typeof right !== "boolean") throw new Error("|| expects booleans");
    return right;
  }
  const right = evaluate(expression.right, environment);
  if (["+", "-", "*", "/", "%", "<", "<=", ">", ">="].includes(expression.operator)) {
    if (typeof left !== "number" || typeof right !== "number") throw new Error(`${expression.operator} expects numbers`);
    let result: number | boolean;
    if (expression.operator === "+") result = left + right;
    else if (expression.operator === "-") result = left - right;
    else if (expression.operator === "*") result = left * right;
    else if (expression.operator === "/") {
      if (right === 0) throw new Error("division by zero");
      result = left / right;
    } else if (expression.operator === "%") {
      if (right === 0) throw new Error("modulo by zero");
      result = left % right;
    } else if (expression.operator === "<") result = left < right;
    else if (expression.operator === "<=") result = left <= right;
    else if (expression.operator === ">") result = left > right;
    else result = left >= right;
    if (typeof result === "number" && !Number.isFinite(result)) throw new Error("non-finite numeric result");
    return result;
  }
  if (expression.operator === "==") return left === right;
  if (expression.operator === "!=") return left !== right;
  throw new Error(`unsupported operator '${expression.operator}'`);
}

function print(expression: Expression): string {
  if (expression.kind === "literal") return String(expression.value);
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind === "unary") return `${expression.operator}(${print(expression.operand)})`;
  return `(${print(expression.left)} ${expression.operator} ${print(expression.right)})`;
}

function same(left: Expression, right: Expression): boolean {
  return print(left) === print(right);
}

function simplify(expression: Expression): Expression {
  if (expression.kind === "literal" || expression.kind === "identifier") return expression;
  if (expression.kind === "unary") {
    const operand = simplify(expression.operand);
    if (operand.kind === "literal") {
      try {
        return { kind: "literal", value: evaluate({ ...expression, operand }, {}) };
      } catch {
        return { ...expression, operand };
      }
    }
    if (expression.operator === "!" && operand.kind === "unary" && operand.operator === "!") return simplify(operand.operand);
    return { ...expression, operand };
  }
  let left = simplify(expression.left);
  let right = simplify(expression.right);
  if (left.kind === "literal" && right.kind === "literal") {
    try {
      return { kind: "literal", value: evaluate({ ...expression, left, right }, {}) };
    } catch {
      return { ...expression, left, right };
    }
  }
  if (["+", "*", "&&", "||", "==", "!="].includes(expression.operator) && print(left) > print(right)) [left, right] = [right, left];
  if (expression.operator === "+" && right.kind === "literal" && right.value === 0) return left;
  if (expression.operator === "+" && left.kind === "literal" && left.value === 0) return right;
  if (expression.operator === "-" && right.kind === "literal" && right.value === 0) return left;
  if (expression.operator === "*" && right.kind === "literal" && right.value === 1) return left;
  if (expression.operator === "*" && left.kind === "literal" && left.value === 1) return right;
  if (expression.operator === "*" && right.kind === "literal" && right.value === 0) return right;
  if (expression.operator === "*" && left.kind === "literal" && left.value === 0) return left;
  if (expression.operator === "/" && right.kind === "literal" && right.value === 1) return left;
  if (expression.operator === "&&" && right.kind === "literal" && right.value === true) return left;
  if (expression.operator === "&&" && left.kind === "literal" && left.value === true) return right;
  if (expression.operator === "&&" && right.kind === "literal" && right.value === false) return right;
  if (expression.operator === "&&" && left.kind === "literal" && left.value === false) return left;
  if (expression.operator === "||" && right.kind === "literal" && right.value === false) return left;
  if (expression.operator === "||" && left.kind === "literal" && left.value === false) return right;
  if (expression.operator === "||" && right.kind === "literal" && right.value === true) return right;
  if (expression.operator === "||" && left.kind === "literal" && left.value === true) return left;
  if (["==", "<=", ">="].includes(expression.operator) && same(left, right)) return { kind: "literal", value: true };
  if (["!=", "<", ">"].includes(expression.operator) && same(left, right)) return { kind: "literal", value: false };
  return { ...expression, left, right };
}

function rewrites(expression: Expression): Expression[] {
  const results: Expression[] = [simplify(expression)];
  if (expression.kind === "unary") {
    results.push(...rewrites(expression.operand).map((operand) => ({ ...expression, operand })));
    return results;
  }
  if (expression.kind !== "binary") return results;
  results.push(
    ...rewrites(expression.left).map((left) => ({ ...expression, left })),
    ...rewrites(expression.right).map((right) => ({ ...expression, right })),
  );
  if (["+", "*", "&&", "||", "==", "!="].includes(expression.operator)) {
    results.push({ ...expression, left: expression.right, right: expression.left });
  }
  if (["+", "*", "&&", "||"].includes(expression.operator)) {
    if (expression.left.kind === "binary" && expression.left.operator === expression.operator) {
      results.push({
        ...expression,
        left: expression.left.left,
        right: { kind: "binary", operator: expression.operator, left: expression.left.right, right: expression.right },
      });
    }
    if (expression.right.kind === "binary" && expression.right.operator === expression.operator) {
      results.push({
        ...expression,
        left: { kind: "binary", operator: expression.operator, left: expression.left, right: expression.right.left },
        right: expression.right.right,
      });
    }
  }
  return results;
}

function saturate(expression: Expression, limit = 1_000): Map<string, Expression> {
  const expressions = new Map<string, Expression>();
  const queue = [expression];
  while (queue.length && expressions.size < limit) {
    const current = queue.shift()!;
    const key = print(current);
    if (expressions.has(key)) continue;
    expressions.set(key, current);
    for (const next of rewrites(current)) if (!expressions.has(print(next))) queue.push(next);
  }
  return expressions;
}

function cheapest(expressions: Iterable<Expression>): Expression {
  return [...expressions].sort((left, right) => print(left).length - print(right).length || print(left).localeCompare(print(right)))[0];
}

function domains(variables: ExperimentVariable[]): Value[][] {
  const names = new Set<string>();
  return variables.map((variable) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name) || variable.name === "result" || names.has(variable.name)) {
      throw new Error(`invalid or duplicate variable '${variable.name}'`);
    }
    names.add(variable.name);
    if (variable.type === "boolean") return [false, true];
    const minimum = variable.minimum ?? -10;
    const maximum = variable.maximum ?? 10;
    if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum || maximum - minimum > 100) {
      throw new Error(`integer domain for '${variable.name}' must contain at most 101 safe integers`);
    }
    return Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index);
  });
}

function environments(variables: ExperimentVariable[], maximumCases: number): { values: Array<Record<string, Value>>; exhaustive: boolean } {
  if (!Number.isSafeInteger(maximumCases) || maximumCases < 1 || maximumCases > 100_000) throw new Error("maximumCases must be between 1 and 100000");
  const choices = domains(variables);
  const total = choices.reduce((product, values) => product * values.length, 1);
  if (total <= maximumCases) {
    let values: Array<Record<string, Value>> = [{}];
    for (let index = 0; index < variables.length; index += 1) {
      values = values.flatMap((environment) => choices[index].map((value) => ({ ...environment, [variables[index].name]: value })));
    }
    return { values, exhaustive: true };
  }
  let seed = 0x5f3759df;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const values = Array.from({ length: maximumCases }, () =>
    Object.fromEntries(variables.map((variable, index) => [variable.name, choices[index][Math.floor(random() * choices[index].length)]])),
  );
  return { values, exhaustive: false };
}

interface Outcome {
  ok: boolean;
  value?: Value;
  error?: string;
}

function outcome(expression: Expression, environment: Record<string, Value>): Outcome {
  try {
    return { ok: true, value: evaluate(expression, environment) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function equivalent(left: Outcome, right: Outcome): boolean {
  return left.ok === right.ok && (left.ok ? Object.is(left.value, right.value) : left.error === right.error);
}

function inferInvariants(outcomes: Outcome[]): Record<string, unknown> {
  const values = outcomes.filter((item): item is Outcome & { ok: true; value: Value } => item.ok);
  const numbers = values.map((item) => item.value).filter((value): value is number => typeof value === "number");
  return {
    successfulCases: values.length,
    errorCases: outcomes.length - values.length,
    resultTypes: [...new Set(values.map((item) => typeof item.value))],
    minimum: numbers.length ? Math.min(...numbers) : undefined,
    maximum: numbers.length ? Math.max(...numbers) : undefined,
    nonnegative: numbers.length ? numbers.every((value) => value >= 0) : undefined,
    integer: numbers.length ? numbers.every(Number.isInteger) : undefined,
    deterministic: true,
  };
}

function mutants(expression: Expression): Expression[] {
  const replacements: Record<string, string[]> = {
    "+": ["-", "*"],
    "-": ["+"],
    "*": ["+", "/"],
    "/": ["*"],
    "<": ["<=", ">"],
    "<=": ["<", ">="],
    ">": [">=", "<"],
    ">=": [">", "<="],
    "==": ["!="],
    "!=": ["=="],
    "&&": ["||"],
    "||": ["&&"],
  };
  if (expression.kind === "literal" || expression.kind === "identifier") return [];
  if (expression.kind === "unary") return mutants(expression.operand).map((operand) => ({ ...expression, operand }));
  return [
    ...(replacements[expression.operator] ?? []).map((operator) => ({ ...expression, operator })),
    ...mutants(expression.left).map((left) => ({ ...expression, left })),
    ...mutants(expression.right).map((right) => ({ ...expression, right })),
  ];
}

function regressionTest(spec: ExperimentSpec, environment: Record<string, unknown>, index: number): string {
  const declarations = Object.entries(environment).map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`).join(" ");
  const original = spec.original.replace(/!=|==/g, (operator) => operator === "!=" ? "!==" : "===");
  const candidate = spec.candidate.replace(/!=|==/g, (operator) => operator === "!=" ? "!==" : "===");
  return `test(${JSON.stringify(`${spec.id} regression ${index + 1}`)}, () => { ${declarations} const capture = (fn: () => unknown) => { try { return { ok: true, value: fn() }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; } }; expect(capture(() => (${candidate}))).toEqual(capture(() => (${original}))); });`;
}

function relationPasses(relation: string, before: Outcome, after: Outcome): boolean {
  if (!before.ok || !after.ok) return equivalent(before, after);
  if (relation === "equal") return Object.is(before.value, after.value);
  if (relation === "not-equal") return !Object.is(before.value, after.value);
  if (typeof before.value !== "number" || typeof after.value !== "number") return false;
  return relation === "nondecreasing" ? after.value >= before.value : after.value <= before.value;
}

function toSmt(expression: Expression): string {
  if (expression.kind === "literal") {
    if (typeof expression.value === "boolean") return String(expression.value);
    if (!Number.isInteger(expression.value)) throw new Error("SMT adapter supports integer literals only");
    return String(expression.value);
  }
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind === "unary") return expression.operator === "!" ? `(not ${toSmt(expression.operand)})` : `(- ${toSmt(expression.operand)})`;
  const left = toSmt(expression.left);
  const right = toSmt(expression.right);
  const operators: Record<string, string> = {
    "+": "+", "-": "-", "*": "*", "/": "div", "%": "mod",
    "<": "<", "<=": "<=", ">": ">", ">=": ">=", "&&": "and", "||": "or", "==": "=",
  };
  if (expression.operator === "!=") return `(not (= ${left} ${right}))`;
  const operator = operators[expression.operator];
  if (!operator) throw new Error(`SMT adapter does not support '${expression.operator}'`);
  return `(${operator} ${left} ${right})`;
}

export function expressionEquivalenceSmt(spec: ExperimentSpec): string {
  const variables = new Map(spec.variables.map((variable) => [variable.name, variable.type]));
  const original = parse(spec.original);
  const candidate = parse(spec.candidate);
  if (expressionType(original, variables) !== expressionType(candidate, variables)) throw new Error("original and candidate expressions have different types");
  const declarations = spec.variables.map((variable) => `(declare-const ${variable.name} ${variable.type === "boolean" ? "Bool" : "Int"})`);
  const bounds = spec.variables.flatMap((variable) =>
    variable.type === "integer"
      ? [
          variable.minimum === undefined ? undefined : `(assert (>= ${variable.name} ${variable.minimum}))`,
          variable.maximum === undefined ? undefined : `(assert (<= ${variable.name} ${variable.maximum}))`,
        ].filter((item): item is string => Boolean(item))
      : [],
  );
  return [...declarations, ...bounds, `(assert (not (= ${toSmt(original)} ${toSmt(candidate)})))`, "(check-sat)", "(get-model)"].join("\n");
}

export function runExpressionExperiment(spec: ExperimentSpec): ExperimentResult {
  const assumptions = [
    "side-effect-free expressions only",
    "JavaScript-like strict equality and finite-number arithmetic",
    "integer domains are explicit and contain at most 101 values per variable",
    "division or modulo by zero is modeled as an error",
    "equality saturation is advisory and never establishes verification authority",
  ];
  try {
    const original = parse(spec.original);
    const candidate = parse(spec.candidate);
    const variables = new Map(spec.variables.map((variable) => [variable.name, variable.type]));
    const originalType = expressionType(original, variables);
    const candidateType = expressionType(candidate, variables);
    if (originalType !== candidateType) throw new Error("original and candidate expressions have different types");
    const propertyExpressions = spec.properties.map(parse);
    for (const property of propertyExpressions) expressionType(property, variables, originalType);
    const metamorphicExpressions = spec.metamorphic.map((relation) => ({
      relation,
      transforms: Object.fromEntries(Object.entries(relation.transform).map(([name, expression]) => {
        const transformed = parse(expression);
        expressionType(transformed, variables);
        return [name, transformed];
      })),
    }));
    const generated = environments(spec.variables, spec.maximumCases);
    const originalOutcomes: Outcome[] = [];
    const candidateOutcomes: Outcome[] = [];
    const counterexamples: Array<Record<string, unknown>> = [];
    for (const environment of generated.values) {
      const before = outcome(original, environment);
      const after = outcome(candidate, environment);
      originalOutcomes.push(before);
      candidateOutcomes.push(after);
      if (!equivalent(before, after) && counterexamples.length < 20) counterexamples.push({ environment, original: before, candidate: after });
      for (const property of propertyExpressions) {
        const originalProperty = before.ok
          ? outcome(property, { ...environment, result: before.value as Value })
          : { ok: false as const, error: `original expression failed: ${before.error ?? "unknown error"}` };
        const candidateProperty = after.ok
          ? outcome(property, { ...environment, result: after.value as Value })
          : { ok: false as const, error: `candidate expression failed: ${after.error ?? "unknown error"}` };
        if ((!originalProperty.ok || originalProperty.value !== true || !candidateProperty.ok || candidateProperty.value !== true) && counterexamples.length < 20) {
          counterexamples.push({ environment, property: print(property), original: originalProperty, candidate: candidateProperty });
        }
      }
    }
    const metamorphic = metamorphicExpressions.map(({ relation, transforms }) => {
      for (const environment of generated.values) {
        let transformed: Record<string, Value>;
        try {
          transformed = {
            ...environment,
            ...Object.fromEntries(Object.entries(transforms).map(([name, expression]) => [name, evaluate(expression, environment)])),
          };
        } catch (error) {
          return { name: relation.name, passed: false, counterexample: { environment, error: error instanceof Error ? error.message : String(error) } };
        }
        const originalPasses = relationPasses(relation.relation, outcome(original, environment), outcome(original, transformed));
        const candidatePasses = relationPasses(relation.relation, outcome(candidate, environment), outcome(candidate, transformed));
        if (!originalPasses || !candidatePasses) return { name: relation.name, passed: false, counterexample: { environment, transformed, originalPasses, candidatePasses } };
      }
      return { name: relation.name, passed: true };
    });
    const generatedMutants = [...new Map(mutants(candidate).map((mutant) => [print(mutant), mutant])).values()].slice(0, 200);
    const killed = generatedMutants.filter((mutant) =>
      generated.values.some((environment) => !equivalent(outcome(mutant, environment), outcome(candidate, environment))),
    ).length;
    const originalClass = saturate(original);
    const candidateClass = saturate(candidate);
    const shared = [...originalClass.keys()].filter((key) => candidateClass.has(key));
    const originalCanonical = print(cheapest(originalClass.values()));
    const candidateCanonical = print(cheapest(candidateClass.values()));
    const saturationEquivalent = shared.length > 0;
    const relationFailures = metamorphic.some((item) => !item.passed);
    const equivalentCases = counterexamples.length === 0 && !relationFailures;
    const status: ExperimentResult["status"] = !equivalentCases
      ? "refuted"
      : generated.exhaustive
        ? "verified"
        : "inconclusive";
    const simplified = cheapest(originalClass.values());
    const synthesized = print(simplified);
    const cegisEquivalent = generated.values.every((environment) => equivalent(outcome(original, environment), outcome(simplified, environment)));
    const generatedRegressionCases = counterexamples.map((item) => item.environment as Record<string, unknown>).filter(Boolean);
    return {
      schemaVersion: SCHEMA_VERSION,
      id: fingerprint("experiment", { spec, status, counterexamples }),
      specId: spec.id,
      status,
      bounded: true,
      cases: generated.values.length,
      counterexamples,
      generatedRegressionCases,
      generatedRegressionTests: generatedRegressionCases.map((environment, index) => regressionTest(spec, environment, index)),
      invariants: { original: inferInvariants(originalOutcomes), candidate: inferInvariants(candidateOutcomes) },
      mutation: {
        generated: generatedMutants.length,
        killed,
        score: generatedMutants.length ? killed / generatedMutants.length : null,
      },
      equalitySaturation: { originalCanonical, candidateCanonical, equivalent: saturationEquivalent },
      cegis: {
        candidate: cegisEquivalent && synthesized.length < spec.original.length ? synthesized : undefined,
        iterations: 1,
        counterexamples: cegisEquivalent ? 0 : 1,
      },
      metamorphic,
      assumptions: [...assumptions, generated.exhaustive ? "the configured finite domain was exhausted" : `deterministic sampling was capped at ${spec.maximumCases} cases`],
    };
  } catch (error) {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: fingerprint("experiment", { spec, error: error instanceof Error ? error.message : String(error) }),
      specId: spec.id,
      status: "abstained",
      bounded: true,
      cases: 0,
      counterexamples: [],
      generatedRegressionCases: [],
      generatedRegressionTests: [],
      invariants: { original: {}, candidate: {} },
      mutation: { generated: 0, killed: 0, score: null },
      equalitySaturation: { originalCanonical: "", candidateCanonical: "", equivalent: false },
      cegis: { iterations: 0, counterexamples: 0 },
      metamorphic: [],
      assumptions,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
}
