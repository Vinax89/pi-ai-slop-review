import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

interface PackedFile {
  path: string;
}

function firstPackResult(output: string): { files?: PackedFile[]; filename?: string } | undefined {
  const parsed = JSON.parse(output) as Array<{ files?: PackedFile[]; filename?: string }> | Record<string, { files?: PackedFile[]; filename?: string }>;
  return Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
}

function packedFiles(): string[] {
  const output = execFileSync("npm", ["pack", "--ignore-scripts", "--dry-run", "--json"], { encoding: "utf8" });
  return firstPackResult(output)?.files?.map((item) => item.path) ?? [];
}

test("skill keeps conservative evidence policy and explicit repository aliases", () => {
  const skill = readFileSync(new URL("../skills/ai-slop-review/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /workspace.*whole project.*full repository.*full workspace/);
  assert.match(skill, /identity wrapper only when reference coverage is complete or independent positive evidence/);
  assert.match(skill, /Matching signatures and bodies establish duplication, not by themselves a maintenance problem/);
  assert.match(skill, /Evidence IDs are finding-scoped/);
  assert.match(skill, /Missing static edges are not proof of no callers/);
  assert.match(skill, /Import cycle: classify runtime versus type-only and registration edges/);
  assert.match(skill, /Explicit placeholder: inspect callers, interfaces, subclasses, feature registration, and tests/);
  assert.doesNotMatch(skill, /deslop-js|karpeslop|lintmax|vibecheck/i);
  assert.doesNotMatch(skill, /Confirm an unexported identity wrapper with no discovered callers/);
});

test("every registered Pi tool names itself in each prompt guideline", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  const registrations = [...source.matchAll(/pi\.registerTool\(\{[\s\S]*?name: "([^"]+)"[\s\S]*?promptGuidelines: \[([\s\S]*?)\],\n\s+parameters:/g)];
  assert.ok(registrations.length >= 9);
  for (const [, toolName, block] of registrations) {
    const guidelines = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    assert.ok(guidelines.length > 0, `${toolName} has no prompt guidelines`);
    for (const guideline of guidelines) assert.match(guideline, new RegExp(`\\b${toolName}\\b`), `${toolName} guideline does not name its tool`);
  }
});

test("npm pack contains runtime, schema, documentation, and metadata artifacts", () => {
  const files = packedFiles();
  for (const required of ["dist/src/isolated-scan.js", "dist/src/python_common.py", "index.ts", "skills/ai-slop-review/SKILL.md", "src/evaluation/corpus.ts", "src/evaluation/artifacts.ts", "schema/config.schema.json", "schema/scan-result.schema.json", "README.md", "docs/operations.md"]) {
    assert.ok(files.includes(required), `packed package is missing ${required}`);
  }
  assert.equal(files.some((file) => file.startsWith("test/")), false);
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    engines: { node: string };
    pi: { extensions: string[]; skills: string[] };
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
  };
  assert.equal(packageJson.engines.node, ">=22.7.0");
  assert.deepEqual(packageJson.pi.extensions, ["index.ts"]);
  assert.deepEqual(packageJson.pi.skills, ["skills/ai-slop-review/SKILL.md"]);
  const declaredPeers = Object.keys(packageJson.peerDependencies).sort();
  assert.deepEqual(declaredPeers, ["@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"]);
  for (const peer of declaredPeers) assert.equal(packageJson.peerDependenciesMeta[peer]?.optional, true, `${peer} must be optional`);
  const shrinkwrap = JSON.parse(readFileSync(new URL("../npm-shrinkwrap.json", import.meta.url), "utf8")) as {
    packages: { "": { peerDependencies: Record<string, string>; peerDependenciesMeta: Record<string, { optional?: boolean }> } };
  };
  assert.deepEqual(shrinkwrap.packages[""].peerDependencies, packageJson.peerDependencies);
  assert.deepEqual(shrinkwrap.packages[""].peerDependenciesMeta, packageJson.peerDependenciesMeta);
});

test("packed evaluation module imports and loads the bundled corpus", () => {
  const destination = mkdtempSync(path.join(tmpdir(), "ai-slop-pack-"));
  try {
    const packOutput = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], { encoding: "utf8" });
    const archive = firstPackResult(packOutput)?.filename;
    assert.ok(archive);
    execFileSync("tar", ["-xzf", path.join(destination, archive)], { cwd: destination });
    const extracted = path.join(destination, "package");
    const script = "import { loadCorpus } from './src/evaluation/corpus.ts'; process.stdout.write(JSON.stringify({ count: loadCorpus('./library/cases.jsonl').length }));";
    const runtimeOutput = execFileSync(process.execPath, ["--experimental-strip-types", "--experimental-transform-types", "--input-type=module", "-e", script], { cwd: extracted, encoding: "utf8" });
    const count = JSON.parse(runtimeOutput).count as number;
    assert.ok(count >= 31, `packed corpus contains ${count} cases`);
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});

test("packed compiled worker scans TypeScript and Python from node_modules", () => {
  const destination = mkdtempSync(path.join(tmpdir(), "ai-slop-entrypoint-pack-"));
  try {
    const packOutput = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], { encoding: "utf8" });
    const archive = firstPackResult(packOutput)?.filename;
    assert.ok(archive);
    const extracted = path.join(destination, "node_modules", "pi-ai-slop-review");
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", path.join(destination, archive), "--strip-components=1", "-C", extracted]);
    // npm 12 excludes shrinkwrap metadata from published tarballs; install the
    // exact production dependency declared by the packed manifest.
    execFileSync("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-package-lock"], { cwd: extracted, stdio: "ignore" });
    writeFileSync(path.join(extracted, "input.ts"), "export const value = 1;\n");
    writeFileSync(path.join(extracted, "input.py"), "value = 1\n");
    // Runtime imports exercise the extracted package rather than this test module's source tree.
    const script = "const { scanFilesIsolated, resetIsolatedScanWorker } = await import('./dist/src/isolated-scan.js'); const { DEFAULT_CONFIG } = await import('./dist/src/core/config.js'); const config = structuredClone(DEFAULT_CONFIG); config.graph.enabled = false; const result = await scanFilesIsolated('.', ['input.ts', 'input.py'], undefined, 'explicit', { config }); await resetIsolatedScanWorker(); process.stdout.write(JSON.stringify({ scannedFiles: result.scannedFiles, status: result.completeness?.status }));";
    const runtimeOutput = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: extracted,
      encoding: "utf8",
    });
    const packedResult = JSON.parse(runtimeOutput) as { scannedFiles: string[]; status: string };
    assert.deepEqual(packedResult.scannedFiles.sort(), ["input.py", "input.ts"]);
    assert.notEqual(packedResult.status, "abstained");
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
