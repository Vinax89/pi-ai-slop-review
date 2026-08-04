import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

interface PackedFile {
  path: string;
}

function packedFiles(): string[] {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
  const rows = JSON.parse(output) as Array<{ files: PackedFile[] }>;
  return rows[0]?.files.map((item) => item.path) ?? [];
}

test("npm pack contains runtime, schema, documentation, and metadata artifacts", () => {
  const files = packedFiles();
  for (const required of ["index.ts", "src/evaluation/corpus.ts", "src/evaluation/artifacts.ts", "schema/config.schema.json", "schema/scan-result.schema.json", "README.md", "docs/operations.md", "npm-shrinkwrap.json"]) {
    assert.ok(files.includes(required), `packed package is missing ${required}`);
  }
  assert.equal(files.some((file) => file.startsWith("test/")), false);
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    engines: { node: string };
    peerDependencies: Record<string, string>;
    peerDependenciesMeta: Record<string, { optional?: boolean }>;
  };
  assert.equal(packageJson.engines.node, ">=22.7.0");
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
    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], { encoding: "utf8" });
    const rows = JSON.parse(packOutput) as Array<{ filename: string }>;
    const archive = rows[0]?.filename;
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

test("packed entrypoint imports without optional peer modules", () => {
  const destination = mkdtempSync(path.join(tmpdir(), "ai-slop-entrypoint-pack-"));
  try {
    const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", destination], { encoding: "utf8" });
    const rows = JSON.parse(packOutput) as Array<{ filename: string }>;
    const archive = rows[0]?.filename;
    assert.ok(archive);
    execFileSync("tar", ["-xzf", path.join(destination, archive)], { cwd: destination });
    const extracted = path.join(destination, "package");
    execFileSync("npm", ["ci", "--ignore-scripts", "--omit=dev", "--no-audit"], { cwd: extracted, stdio: "ignore" });
    const script = "await import('./index.ts'); process.stdout.write('ok');";
    const runtimeOutput = execFileSync(process.execPath, ["--experimental-strip-types", "--experimental-transform-types", "--input-type=module", "-e", script], {
      cwd: extracted,
      encoding: "utf8",
    });
    assert.equal(runtimeOutput, "ok");
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
});
