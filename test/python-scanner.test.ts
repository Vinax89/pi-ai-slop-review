import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { scanPythonFiles } from "../src/python-scanner.ts";

function project(files: Record<string, string>, pyproject?: { dependencies?: string[] }): string {
  const root = mkdtempSync(path.join(tmpdir(), "pi-ai-slop-python-"));
  if (pyproject) {
    const dependencies = pyproject.dependencies ?? [];
    writeFileSync(
      path.join(root, "pyproject.toml"),
      `[project]\nname = "fixture"\nversion = "0.0.0"\ndependencies = [${dependencies.map((item) => `"${item}"`).join(", ")}]\n`,
    );
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

test("extracts imports with Python AST and resolves stdlib, local, and declared modules", async () => {
  const root = project(
    {
      "local_module.py": "value = 1\n",
      "input.py": [
        "import os",
        "import local_module",
        "import declared_package",
        "import surely_missing_package",
      ].join("\n"),
    },
    { dependencies: ["declared-package>=1"] },
  );
  const result = await scanPythonFiles(root, ["input.py"]);
  const unresolved = result.findings.filter((finding) => finding.ruleId === "dependency.unresolved");
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].message, /surely_missing_package/);
  assert.equal(unresolved[0].confidence, "C2");
});

test("suppresses type-checking, optional, and platform-specific imports", async () => {
  const root = project({
    "input.py": [
      "import sys",
      "from typing import TYPE_CHECKING",
      "if TYPE_CHECKING:",
      "    import type_only_missing",
      "try:",
      "    with optional_context():",
      "        import optional_missing",
      "except ImportError:",
      "    optional_missing = None",
      "if sys.platform == 'win32':",
      "    import windows_only_missing",
    ].join("\n"),
  });
  const result = await scanPythonFiles(root, ["input.py"]);
  assert.deepEqual(result.findings.filter((finding) => finding.ruleId === "dependency.unresolved"), []);
});

test("reports Python wrappers only as heuristic observations", async () => {
  const root = project({
    "input.py": [
      "def target(value):",
      "    return value",
      "def wrapper(value):",
      "    return target(value)",
      "def transformed(value):",
      "    return target(value.strip())",
      "@decorator",
      "def decorated(value):",
      "    return target(value)",
      "def recursive(value):",
      "    return recursive(value)",
    ].join("\n"),
  });
  const wrappers = (await scanPythonFiles(root, ["input.py"])).findings.filter(
    (finding) => finding.ruleId === "structure.pass-through-wrapper",
  );
  assert.equal(wrappers.length, 1);
  assert.equal(wrappers[0].confidence, "C1");
  assert.equal(wrappers[0].maximumAction, "observe");
});

test("distinguishes suppressed exceptions, hidden fallbacks, and typed errors", async () => {
  const root = project({
    "input.py": [
      "def empty():",
      "    try:",
      "        return work()",
      "    except Exception:",
      "        pass",
      "def logged():",
      "    try:",
      "        return work()",
      "    except Exception as error:",
      "        logger.warning(error)",
      "def fallback():",
      "    try:",
      "        return work()",
      "    except Exception as error:",
      "        logger.warning(error)",
      "        return 0",
      "def typed():",
      "    try:",
      "        return work()",
      "    except Exception as error:",
      "        return {'ok': False, 'error': error}",
      "def rethrow():",
      "    try:",
      "        return work()",
      "    except Exception:",
      "        raise",
    ].join("\n"),
  });
  const findings = (await scanPythonFiles(root, ["input.py"])).findings;
  assert.equal(findings.filter((finding) => finding.ruleId === "errors.suppressed").length, 2);
  assert.equal(findings.filter((finding) => finding.ruleId === "data.hidden-catch-fallback").length, 1);
});

test("treats explicit predicate true/false outcomes as intentional", async () => {
  const root = project({
    "input.py": [
      "def is_inside(root, candidate):",
      "    try:",
      "        candidate.relative_to(root)",
      "        return True",
      "    except ValueError:",
      "        return False",
    ].join("\n"),
  });
  const findings = await scanPythonFiles(root, ["input.py"]);
  assert.equal(findings.findings.some((finding) => finding.ruleId === "data.hidden-catch-fallback"), false);
});

test("skips generated and syntactically invalid Python", async () => {
  const root = project({
    "generated.py": "# @generated\nvalue = 1\n",
    "broken.py": "def broken(:\n",
  });
  const generated = await scanPythonFiles(root, ["generated.py"]);
  const broken = await scanPythonFiles(root, ["broken.py"]);
  assert.equal(generated.findings.length, 0);
  assert.match(generated.skipped[0].reason, /generated/);
  assert.equal(broken.findings.length, 0);
  assert.match(broken.skipped[0].reason, /syntax/);
});

test("maps Unicode Python ranges to JavaScript UTF-16 offsets", async () => {
  const source = "label = '😀'\ndef wrapper(value):\n    return target(value)\n";
  const root = project({ "input.py": source });
  const wrapper = (await scanPythonFiles(root, ["input.py"])).findings.find(
    (finding) => finding.ruleId === "structure.pass-through-wrapper",
  );
  assert.ok(wrapper);
  const disk = readFileSync(path.join(root, "input.py"), "utf8");
  assert.match(disk.slice(wrapper.start, wrapper.end), /def wrapper/);
  assert.equal(wrapper.sourceHash.length, 64);
});

test("accepts configured Python helper output above Node's default buffer and skips output-limit failures", async () => {
  const root = project({ "input.py": "value = 1\n" });
  const helper = path.join(root, "large-output-helper.py");
  writeFileSync(
    helper,
    [
      "#!/usr/bin/env python3",
      "import json",
      "import sys",
      "",
      'payload = {"engineVersion": "test-helper", "scannedFiles": [sys.argv[-1]], "findings": [], "skipped": []}',
      'sys.stdout.write(json.dumps(payload) + (" " * (2 * 1024 * 1024)))',
      "",
    ].join("\n"),
  );
  chmodSync(helper, 0o755);

  const previousPython = process.env.PI_AI_SLOP_PYTHON;
  process.env.PI_AI_SLOP_PYTHON = helper;
  try {
    const accepted = await scanPythonFiles(root, ["input.py"], undefined, {
      maxOutputBytes: 3 * 1024 * 1024,
      commandTimeoutMs: 5_000,
    });
    assert.deepEqual(accepted.scannedFiles, ["input.py"]);
    assert.deepEqual(accepted.skipped, []);

    const limited = await scanPythonFiles(root, ["input.py"], undefined, {
      maxOutputBytes: 64 * 1024,
      commandTimeoutMs: 5_000,
    });
    assert.deepEqual(limited.scannedFiles, []);
    assert.equal(limited.findings.length, 0);
    assert.equal(limited.skipped.length, 1);
    assert.match(limited.skipped[0].reason, /maxBuffer|exceeded|length/i);
  } finally {
    if (previousPython === undefined) delete process.env.PI_AI_SLOP_PYTHON;
    else process.env.PI_AI_SLOP_PYTHON = previousPython;
  }
});
