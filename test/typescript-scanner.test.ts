import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as ts from "typescript";

import { scanTypeScriptFiles } from "../src/typescript-scanner.ts";

function project(files: Record<string, string>, tsconfig: object = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-"));
  writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, ...tsconfig } }),
  );
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

function ruleIds(root: string, file: string): string[] {
  return scanTypeScriptFiles(root, [file]).findings.map((finding) => finding.ruleId);
}

test("uses TypeScript resolution and ignores Node builtins", () => {
  const root = project({
    "input.ts": "import fs from 'node:fs';\nimport styles from './style.module.css';\nimport missing from 'not-a-real-package';\nvoid fs; void styles; void missing;\n",
    "style.module.css": ".root { display: block; }\n",
  });
  const result = scanTypeScriptFiles(root, ["input.ts"]);
  const unresolved = result.findings.filter((finding) => finding.ruleId === "dependency.unresolved");
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].message, /not-a-real-package/);
  assert.equal(unresolved[0].confidence, "C3");
});

test("honors tsconfig path aliases", () => {
  const root = project(
    {
      "src/value.ts": "export const value = 1;\n",
      "src/input.ts": "import { value } from '@app/value';\nvoid value;\n",
    },
    { baseUrl: ".", paths: { "@app/*": ["src/*"] } },
  );
  assert.deepEqual(ruleIds(root, "src/input.ts"), []);
});

test("does not load unrelated project files for non-wrapper reviews", () => {
  const root = project({
    "input.ts": "export const value = 1;\n",
    "unrelated.ts": "export const unrelated = 2;\n",
  });
  const unrelated = path.join(root, "unrelated.ts");
  const reads = new Set<string>();
  const readFile = ts.sys.readFile;
  ts.sys.readFile = (fileName, encoding) => {
    reads.add(path.resolve(fileName));
    return readFile(fileName, encoding);
  };
  try {
    scanTypeScriptFiles(root, ["input.ts"]);
  } finally {
    ts.sys.readFile = readFile;
  }
  assert.equal(reads.has(unrelated), false);
});

test("promotes local identity wrappers but caps exported wrappers", () => {
  const root = project({
    "input.ts": [
      "function load(id: string) { return id; }",
      "function local(id: string) { return load(id); }",
      "export function publicAlias(id: string) { return load(id); }",
      "function transformed(id: string) { return load(id.trim()); }",
      "local('x'); publicAlias('x'); transformed('x');",
    ].join("\n"),
  });
  const wrappers = scanTypeScriptFiles(root, ["input.ts"]).findings.filter(
    (finding) => finding.ruleId === "structure.pass-through-wrapper",
  );
  assert.equal(wrappers.length, 2);
  assert.deepEqual(
    wrappers.map((finding) => [finding.message.includes("publicAlias"), finding.confidence, finding.maximumAction]),
    [
      [false, "C2", "propose"],
      [true, "C1", "observe"],
    ],
  );
  assert.match(wrappers[1].counterEvidence.join(" "), /exported/);
});

test("keeps project-wide call evidence for wrapper reviews", () => {
  const root = project({
    "input.ts": "function load(id: string) { return id; }\nexport function wrapper(id: string) { return load(id); }\n",
    "caller.ts": "import { wrapper } from './input.js';\nwrapper('x');\n",
  });
  const wrapper = scanTypeScriptFiles(root, ["input.ts"]).findings.find(
    (finding) => finding.ruleId === "structure.pass-through-wrapper",
  );
  assert.ok(wrapper);
  assert.match(wrapper.evidence.join(" "), /1 direct call/);
});

test("distinguishes suppressed errors, hidden fallbacks, and rethrows", () => {
  const root = project({
    "input.ts": [
      "declare function work(): number;",
      "export function empty() { try { return work(); } catch (error) {} }",
      "export function logged() { try { return work(); } catch (error) { console.warn(error); } }",
      "export function fallback() { try { return work(); } catch (error) { console.warn(error); return 0; } }",
      "export function rethrow() { try { return work(); } catch (error) { throw error; } }",
      "export function typed() { try { return work(); } catch (error) { return { ok: false, error }; } }",
    ].join("\n"),
  });
  const findings = scanTypeScriptFiles(root, ["input.ts"]).findings;
  assert.equal(findings.filter((finding) => finding.ruleId === "errors.suppressed").length, 2);
  assert.equal(findings.filter((finding) => finding.ruleId === "data.hidden-catch-fallback").length, 1);
});

test("skips generated and syntactically invalid files", () => {
  const root = project({
    "generated.ts": "// @generated\nexport const value = 1;\n",
    "broken.ts": "export function broken( {\n",
  });
  const generated = scanTypeScriptFiles(root, ["generated.ts"]);
  const broken = scanTypeScriptFiles(root, ["broken.ts"]);
  assert.equal(generated.findings.length, 0);
  assert.match(generated.skipped[0].reason, /generated/);
  assert.equal(broken.findings.length, 0);
  assert.match(broken.skipped[0].reason, /syntax/);
});

test("caps wrappers that carry explicit contracts, overloads, or this-bound targets", () => {
  const root = project({
    "input.ts": [
      "function load(id: string) { return id; }",
      "function typed(id: string): string { return load(id); }",
      "function overloaded(id: string): string;",
      "function overloaded(id: number): number;",
      "function overloaded(id: string | number) { return load(String(id)); }",
      "const bound = (id: string) => this.load(id);",
      "function recursive(id: string) { return recursive(id); }",
      "typed('x'); overloaded('x'); bound('x');",
    ].join("\n"),
  });
  const wrappers = scanTypeScriptFiles(root, ["input.ts"]).findings.filter(
    (finding) => finding.ruleId === "structure.pass-through-wrapper",
  );
  assert.equal(wrappers.length, 2);
  assert.ok(wrappers.every((finding) => finding.confidence === "C1" && finding.maximumAction === "observe"));
  assert.match(wrappers.find((finding) => finding.message.includes("typed"))?.counterEvidence.join(" ") ?? "", /return contract/);
  assert.equal(wrappers.some((finding) => finding.message.includes("recursive")), false);
});

test("does not treat chained value construction as pass-through delegation", () => {
  const root = project({
    "input.ts": [
      "function now() { return new Date().toISOString(); }",
      "function sorted() { return [...new Set([2, 1])].sort(); }",
      "void now(); void sorted();",
    ].join("\n"),
  });
  assert.equal(ruleIds(root, "input.ts").includes("structure.pass-through-wrapper"), false);
});

test("caps unresolved imports at C2 when no project configuration exists", () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-no-config-"));
  writeFileSync(path.join(root, "input.ts"), "import value from 'missing-package';\nvoid value;\n");
  const unresolved = scanTypeScriptFiles(root, ["input.ts"]).findings.find(
    (finding) => finding.ruleId === "dependency.unresolved",
  );
  assert.ok(unresolved);
  assert.equal(unresolved.confidence, "C2");
  assert.match(unresolved.unknown.join(" "), /no tsconfig/);
});

test("reports exact source ranges against the scanned hash", () => {
  const source = "function load(id: string) { return id; }\nfunction wrapper(id: string) { return load(id); }\nwrapper('x');\n";
  const root = project({ "input.ts": source });
  const result = scanTypeScriptFiles(root, ["input.ts"]);
  const wrapper = result.findings.find((finding) => finding.ruleId === "structure.pass-through-wrapper");
  assert.ok(wrapper);
  const disk = readFileSync(path.join(root, "input.ts"), "utf8");
  assert.match(disk.slice(wrapper.start, wrapper.end), /function wrapper/);
  assert.equal(wrapper.sourceHash.length, 64);
});
