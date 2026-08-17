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

test("resolves stdlib, local, declared, workspace, and inline-script imports", async () => {
  const root = project(
    {
      "local_module.py": "value = 1\n",
      "input.py": [
        "import os",
        "import local_module",
        "import declared_package",
        "import dotenv",
        "import jwt",
        "import surely_missing_package",
      ].join("\n"),
      "backend/requirements.txt": "",
      "backend/repositories/__init__.py": "",
      ".codex/hook.py": "import repositories\n",
      "tools/helper.py": "value = 1\n",
      "tools/run.py": "import helper\n",
      "tools/inline.py": "# /// script\n# dependencies = [\"PyYAML==6\"]\n# ///\nimport yaml\n",
    },
    { dependencies: ["declared-package>=1", "python-dotenv>=1", "PyJWT>=2"] },
  );
  const result = await scanPythonFiles(root, ["input.py"]);
  const unresolved = result.findings.filter((finding) => finding.ruleId === "dependency.unresolved");
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0].message, /surely_missing_package/);
  assert.equal(unresolved[0].confidence, "C2");
  for (const filePath of [".codex/hook.py", "tools/run.py", "tools/inline.py"]) {
    assert.equal((await scanPythonFiles(root, [filePath])).findings.some((finding) => finding.ruleId === "dependency.unresolved"), false);
  }
});

test("resolves dependencies declared in PEP 735 dependency groups", async () => {
  const root = project({
    "pyproject.toml": "[project]\nname = 'fixture'\nversion = '0.0.0'\n\n[dependency-groups]\ndev = ['pytest>=8', 'basedpyright>=1.20']\n",
    "input.py": "import pytest\nimport basedpyright\nimport genuinely_missing\n",
  });
  const unresolved = (await scanPythonFiles(root, ["input.py"])).findings.filter(
    (finding) => finding.ruleId === "dependency.unresolved",
  );
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0]?.message ?? "", /genuinely_missing/);
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
      "try:",
      "    import broad_optional_missing",
      "except Exception:",
      "    broad_optional_missing = None",
      "if sys.platform == 'win32':",
      "    import windows_only_missing",
    ].join("\n"),
  });
  const result = await scanPythonFiles(root, ["input.py"]);
  assert.deepEqual(result.findings.filter((finding) => finding.ruleId === "dependency.unresolved"), []);
});

test("blind fixture emits its unresolved dependency and suppresses its optional accelerator", async () => {
  const root = path.resolve("artifacts/verdict-corpus");
  const result = await scanPythonFiles(root, ["pair5-dependency.py"]);
  const unresolved = result.findings.filter((finding) => finding.ruleId === "dependency.unresolved");
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0]?.message ?? "", /surely_missing_requests/);
  assert.doesNotMatch(unresolved[0]?.message ?? "", /orjson/);
});

test("reports only private production Python wrappers as heuristic observations", async () => {
  const root = project({
    "input.py": [
      "def target(value):",
      "    return value",
      "def _wrapper(value):",
      "    return target(value)",
      "def public_wrapper(value):",
      "    return target(value)",
      "def transformed(value):",
      "    return target(value.strip())",
      "@decorator",
      "def decorated(value):",
      "    return target(value)",
      "def recursive(value):",
      "    return recursive(value)",
    ].join("\n"),
    "tests/test_input.py": "def _wrapper(value):\n    return target(value)\n",
  });
  const wrappers = (await scanPythonFiles(root, ["input.py", "tests/test_input.py"])).findings.filter(
    (finding) => finding.ruleId === "structure.pass-through-wrapper",
  );
  assert.equal(wrappers.length, 1);
  assert.equal(wrappers[0].filePath, "input.py");
  assert.equal(wrappers[0].confidence, "C1");
  assert.equal(wrappers[0].maximumAction, "observe");
});

test("reports explicit Python placeholders without treating ordinary raises or pass as placeholders", async () => {
  const root = project({
    "input.py": [
      "def pending():",
      "    raise NotImplementedError('subclass must implement')",
      "async def later():",
      "    raise NotImplementedError",
      "def rejected():",
      "    raise ValueError('invalid input')",
      "def empty_hook():",
      "    pass",
      "def shadowed(NotImplementedError):",
      "    raise NotImplementedError('ordinary project exception')",
    ].join("\n"),
  });
  const placeholders = (await scanPythonFiles(root, ["input.py"])).findings.filter(
    (finding) => finding.ruleId === "structure.explicit-placeholder",
  );
  assert.equal(placeholders.length, 2);
  assert.match(placeholders[0].message, /pending/);
  assert.match(placeholders[1].message, /later/);
  assert.ok(placeholders.every((finding) => finding.maximumAction === "observe"));
  const shadowedRoot = project({
    "input.py": "class NotImplementedError(Exception):\n    pass\ndef project_error():\n    raise NotImplementedError('ordinary project exception')\n",
  });
  assert.equal((await scanPythonFiles(shadowedRoot, ["input.py"])).findings.some(
    (finding) => finding.ruleId === "structure.explicit-placeholder",
  ), false);
});

test("distinguishes suppressed exceptions, hidden fallbacks, intentional boundaries, and typed errors", async () => {
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
      "def intentional():",
      "    try:",
      "        return work()",
      "    except Exception:  # noqa: BLE001",
      "        logger.warning('disabled')",
      "        # Optional telemetry is never fatal.",
      "def inline_intent():",
      "    try:",
      "        telemetry()",
      "    except Exception:  # telemetry must still never break requests",
      "        pass",
      "def _private_fallback():",
      "    try:",
      "        return work()",
      "    except Exception:",
      "        return 0",
      "def recurring():",
      "    while True:",
      "        try:",
      "            work()",
      "        except Exception:",
      "            logger.warning('retry next iteration')",
      "if __name__ == '__main__':",
      "    try:",
      "        self_check()",
      "    except ExpectedError:",
      "        pass",
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
      "def typed_conflict():",
      "    try:",
      "        return work()",
      "    except Conflict:",
      "        return 0",
      "def documented_fallback():",
      "    try:",
      "        return work()",
      "    except Exception:",
      "        return 0",
      "    # Expected absence retains the prior value.",
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

test("treats named and annotated boolean fallbacks as intentional predicate outcomes", async () => {
  const root = project({
    "input.py": [
      "def is_inside(root, candidate):",
      "    try:",
      "        candidate.relative_to(root)",
      "        return True",
      "    except ValueError:",
      "        return False",
      "def _is_loopback(host):",
      "    try:",
      "        return ip_address(host).is_loopback",
      "    except ValueError:",
      "        return False",
      "def readable(path) -> bool:",
      "    try:",
      "        return path.is_file()",
      "    except OSError:",
      "        return False",
    ].join("\n"),
  });
  const findings = await scanPythonFiles(root, ["input.py"]);
  assert.equal(findings.findings.some((finding) => finding.ruleId === "data.hidden-catch-fallback"), false);
});

test("detects post-handler fallbacks, validator skips, and conditionally unbound locals", async () => {
  const root = project({
    "check_inputs.py": [
      "def _canonical_repo(path):",
      "    try:",
      "        return path.read_text()",
      "    except OSError:",
      "        pass",
      "    return 'owner/repository'",
      "def parse_inputs(paths):",
      "    for path in paths:",
      "        try:",
      "            path.read_text()",
      "        except OSError:",
      "            continue",
      "def parse(document):",
      "    if isinstance(document, dict):",
      "        layout = document.get('layout')",
      "    return layout",
    ].join("\n"),
  });
  const findings = (await scanPythonFiles(root, ["check_inputs.py"])).findings;
  assert.equal(findings.filter((finding) => finding.ruleId === "data.hidden-catch-fallback").length, 1);
  assert.equal(findings.filter((finding) => finding.ruleId === "errors.suppressed").length, 1);
  assert.equal(findings.filter((finding) => finding.ruleId === "correctness.conditionally-unbound-local").length, 1);
});

test("does not flag documented best-effort skips or locals assigned on every branch", async () => {
  const root = project({
    "input.py": [
      "def validate_optional(paths):",
      "    for path in paths:",
      "        try:",
      "            path.read_text()",
      "        except OSError:  # Optional input is best-effort.",
      "            continue",
      "def parse(document):",
      "    if isinstance(document, dict):",
      "        layout = document.get('layout')",
      "    else:",
      "        layout = None",
      "    return layout",
      "def scoped(values, enabled):",
      "    global CACHE",
      "    if enabled:",
      "        CACHE = 1",
      "        labels = [item for item in values]",
      "    result = [item for item in values]",
      "    return CACHE, result",
      "def terminating(enabled):",
      "    if enabled:",
      "        value = 1",
      "    else:",
      "        raise ValueError('disabled')",
      "    return value",
      "def correlated(enabled):",
      "    ready = False",
      "    if enabled:",
      "        value = 1",
      "        ready = True",
      "    if ready:",
      "        return value",
      "    return None",
      "def _matches_value(value):",
      "    try:",
      "        if parse(value):",
      "            return True",
      "    except ValueError:",
      "        pass",
      "    return False",
    ].join("\n"),
  });
  const findings = (await scanPythonFiles(root, ["input.py"])).findings;
  assert.equal(findings.some((finding) => finding.ruleId === "errors.suppressed"), false);
  assert.equal(findings.some((finding) => finding.ruleId === "correctness.conditionally-unbound-local"), false);
});

test("reports inert conditional checks inside tests", async () => {
  const root = project({
    "test_ordering.py": [
      "def test_steps_ordered():",
      "    previous = -1",
      "    for number in steps:",
      "        if number < previous:",
      "            pass",
      "        previous = number",
      "def test_steps_checked():",
      "    for number in steps:",
      "        if number < 0:",
      "            raise AssertionError(number)",
    ].join("\n"),
  });
  const findings = (await scanPythonFiles(root, ["test_ordering.py"])).findings.filter(
    (finding) => finding.ruleId === "assurance.inert-test-check",
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? "", /cannot fail/);
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
  const source = "label = '😀'\ndef _wrapper(value):\n    return target(value)\n";
  const root = project({ "input.py": source });
  const wrapper = (await scanPythonFiles(root, ["input.py"])).findings.find(
    (finding) => finding.ruleId === "structure.pass-through-wrapper",
  );
  assert.ok(wrapper);
  const disk = readFileSync(path.join(root, "input.py"), "utf8");
  assert.match(disk.slice(wrapper.start, wrapper.end), /def _wrapper/);
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
