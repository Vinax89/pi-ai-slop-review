import assert from "node:assert/strict";
import test from "node:test";

import { fingerprint } from "../src/core/schema.ts";
import { formatImportCycle, importCycles } from "../src/graph/analysis.ts";
import type { GraphEdge, GraphNode } from "../src/graph/types.ts";

function file(filePath: string): GraphNode {
  return { id: fingerprint("file", filePath), filePath, kind: "file", name: filePath, qualifiedName: filePath, start: 0, end: 1, exported: false, metadata: {} };
}

function imports(from: GraphNode, to: GraphNode): GraphEdge {
  return { id: fingerprint("edge", { from: from.id, to: to.id }), filePath: from.filePath, fromId: from.id, toId: to.id, kind: "imports", confidence: "C3", metadata: {} };
}

test("import cycle analysis is stable, bounded to resolved files, and ignores acyclic tails", () => {
  const a = file("src/a.ts");
  const b = file("src/b.ts");
  const c = file("src/c.ts");
  const external: GraphNode = { ...file("external"), id: "external", kind: "external" };
  const result = importCycles([c, external, a, b], [imports(c, a), imports(b, c), imports(a, b), imports(a, external)]);
  assert.deepEqual(result.map((cycle) => cycle.files), [["src/a.ts", "src/b.ts", "src/c.ts"]]);
  assert.equal(result[0]?.edgeCount, 3);
  assert.equal(result[0]?.typeOnlyEdgeCount, 0);
});

test("import cycle analysis retains type-only edge provenance", () => {
  const a = file("src/a.ts");
  const b = file("src/b.ts");
  const typeEdge = { ...imports(a, b), metadata: { typeOnly: true } };
  const result = importCycles([a, b], [typeEdge, imports(b, a)]);
  assert.equal(result[0]?.typeOnlyEdgeCount, 1);
});

test("import cycle analysis summarizes high-multiplicity edges as counts", () => {
  const a = file("src/a.ts");
  const b = file("src/b.ts");
  const parallel = Array.from({ length: 10_000 }, (_, index) => ({
    ...imports(a, b),
    id: `parallel-${index}`,
    metadata: { typeOnly: index % 2 === 0 },
  }));
  const [cycle] = importCycles([a, b], [...parallel, imports(b, a)]);
  assert.equal(cycle?.edgeCount, 10_001);
  assert.equal(cycle?.typeOnlyEdgeCount, 5_000);
  assert.deepEqual(Object.keys(cycle ?? {}).sort(), ["edgeCount", "files", "typeOnlyEdgeCount"]);
});

test("import cycle analysis detects self-imports and omits ordinary DAGs", () => {
  const a = file("src/a.ts");
  const b = file("src/b.ts");
  assert.deepEqual(importCycles([a, b], [imports(a, b)]), []);
  assert.deepEqual(importCycles([a], [imports(a, a)]).map((cycle) => cycle.files), [["src/a.ts"]]);
});

test("import cycle analysis applies a deterministic result budget", () => {
  const a = file("src/a.ts");
  const b = file("src/b.ts");
  const y = file("src/y.ts");
  const z = file("src/z.ts");
  const edges = [imports(z, y), imports(y, z), imports(b, a), imports(a, b)];
  assert.deepEqual(importCycles([z, b, y, a], edges, 1).map((cycle) => cycle.files), [["src/a.ts", "src/b.ts"]]);
  assert.deepEqual(importCycles([z, b, y, a], edges, 0), []);
  assert.deepEqual(importCycles([z, b, y, a], edges, Number.NaN), []);
  const typeOnly = edges.slice(2).map((edge) => ({ ...edge, metadata: { typeOnly: true } }));
  assert.deepEqual(importCycles([z, b, y, a], [...typeOnly, ...edges.slice(0, 2)], 1, true).map((cycle) => cycle.files), [["src/y.ts", "src/z.ts"]]);
});

test("import cycle analysis handles deep graphs without recursion and bounds hostile labels", () => {
  const nodes = Array.from({ length: 12_000 }, (_, index) => file(`src/${index}.ts`));
  const edges = nodes.slice(0, -1).map((node, index) => imports(node, nodes[index + 1]!));
  edges.push(imports(nodes.at(-1)!, nodes[0]!));
  assert.equal(importCycles(nodes, edges)[0]?.files.length, nodes.length);
  const summary = formatImportCycle(["src/a\nforged.ts", ...Array.from({ length: 20 }, (_, index) => `src/${"x".repeat(180)}-${index}.ts`)]);
  assert.equal(/[\n\r]/.test(summary), false);
  assert.ok(summary.length < 1_100);
  assert.match(summary, /\(\+13 more\)$/);
});
