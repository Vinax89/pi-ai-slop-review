from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import sys
import sysconfig
from typing import Any

MAX_FILE_BYTES = int(os.environ.get("PI_AI_SLOP_MAX_FILE_BYTES", str(1024 * 1024)))
LOG_METHODS = {"debug", "error", "exception", "info", "log", "trace", "warn", "warning"}
OPTIONAL_IMPORT_ERRORS = {"ImportError", "ModuleNotFoundError"}
DEPENDENCY_NAME_RE = re.compile(r"^\s*([A-Za-z0-9_.-]+)")
sys.dont_write_bytecode = True

_COMMON_SPEC = importlib.util.spec_from_file_location("_pi_ai_slop_python_common", Path(__file__).with_name("python_common.py"))
if _COMMON_SPEC is None or _COMMON_SPEC.loader is None:
    raise RuntimeError("cannot load isolated Python common helpers")
_COMMON = importlib.util.module_from_spec(_COMMON_SPEC)
_COMMON_SPEC.loader.exec_module(_COMMON)
is_inside = _COMMON.is_inside
ancestors = _COMMON.ancestors


def normalized_name(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def utf16_length(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def node_location(source: str, lines: list[str], node: ast.AST) -> dict[str, int]:
    line = max(1, getattr(node, "lineno", 1))
    end_line = max(line, getattr(node, "end_lineno", line))
    byte_column = max(0, getattr(node, "col_offset", 0))
    end_byte_column = max(byte_column, getattr(node, "end_col_offset", byte_column))

    def column_to_text(line_number: int, byte_offset: int) -> str:
        raw = lines[line_number - 1].encode("utf-8")
        return raw[:byte_offset].decode("utf-8", errors="ignore")

    start_prefix = "".join(lines[: line - 1]) + column_to_text(line, byte_column)
    end_prefix = "".join(lines[: end_line - 1]) + column_to_text(end_line, end_byte_column)
    return {
        "line": line,
        "column": utf16_length(column_to_text(line, byte_column)) + 1,
        "start": utf16_length(start_prefix),
        "end": utf16_length(end_prefix),
    }


def finding(
    *,
    root: Path,
    file_path: Path,
    source: str,
    lines: list[str],
    node: ast.AST,
    anchor: str,
    rule_id: str,
    classification: str,
    confidence: str,
    risk: str,
    maximum_action: str,
    message: str,
    evidence: list[str],
    counter_evidence: list[str] | None = None,
    unknown: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "anchor": anchor,
        "ruleId": rule_id,
        "classification": classification,
        "confidence": confidence,
        "risk": risk,
        "maximumAction": maximum_action,
        "filePath": file_path.relative_to(root).as_posix(),
        **node_location(source, lines, node),
        "sourceHash": hashlib.sha256(source.encode("utf-8")).hexdigest(),
        "message": message,
        "evidence": evidence,
        "counterEvidence": counter_evidence or [],
        "unknown": unknown or [],
    }


def parent_map(tree: ast.AST) -> dict[ast.AST, ast.AST]:
    return {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}


def structural_anchor(node: ast.AST, parents: dict[ast.AST, ast.AST], prefix: str) -> str:
    parts: list[int] = []
    current = node
    while current in parents:
        parent = parents[current]
        siblings = list(ast.iter_child_nodes(parent))
        parts.append(siblings.index(current))
        current = parent
    return f"{prefix}:{'.'.join(str(part) for part in reversed(parts))}"


def name_is(node: ast.AST | None, names: set[str]) -> bool:
    if isinstance(node, ast.Name):
        return node.id in names
    if isinstance(node, ast.Attribute):
        return node.attr in names
    if isinstance(node, ast.Tuple):
        return any(name_is(item, names) for item in node.elts)
    return False


def under_type_checking(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> bool:
    return any(isinstance(parent, ast.If) and name_is(parent.test, {"TYPE_CHECKING"}) for parent in ancestors(node, parents))


def contains_node(statements: list[ast.stmt], target: ast.AST) -> bool:
    return any(target in ast.walk(statement) for statement in statements)


def optional_import(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> bool:
    for parent in ancestors(node, parents):
        if not isinstance(parent, ast.Try) or not contains_node(parent.body, node):
            continue
        if any(name_is(handler.type, OPTIONAL_IMPORT_ERRORS) for handler in parent.handlers):
            return True
    return False


def dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = dotted_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def platform_conditional(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> bool:
    for parent in ancestors(node, parents):
        if not isinstance(parent, ast.If):
            continue
        references = {dotted_name(part) for part in ast.walk(parent.test) if isinstance(part, (ast.Name, ast.Attribute))}
        if references & {"sys.platform", "sys.version_info", "os.name", "platform.system", "platform.machine", "platform.python_version"}:
            return True
    return False


def project_roots(root: Path, file_path: Path) -> list[Path]:
    roots = {root, root / "src"}
    current = file_path.parent
    while is_inside(root, current):
        if any((current / marker).exists() for marker in ("pyproject.toml", "setup.cfg", "setup.py", "requirements.txt")):
            roots.update({current, current / "src"})
        if current == root:
            break
        current = current.parent
    for environment in (root / ".venv", root / "venv"):
        roots.update(environment.glob("lib/python*/site-packages"))
        roots.add(environment / "Lib" / "site-packages")
    for key in ("purelib", "platlib"):
        configured = sysconfig.get_paths().get(key)
        if configured:
            roots.add(Path(configured))
    return [candidate for candidate in roots if candidate.is_dir()]


def module_on_disk(module: str, roots: list[Path]) -> bool:
    for root in roots:
        if (root / f"{module}.py").is_file() or (root / module).is_dir():
            return True
        if any(root.glob(f"{module}.*.so")) or any(root.glob(f"{module}.pyd")):
            return True
    return False


def declared_dependencies(root: Path, file_path: Path) -> set[str]:
    dependencies: set[str] = set()
    candidates: list[Path] = []
    current = file_path.parent
    while is_inside(root, current):
        candidates.extend([current / "pyproject.toml", current / "requirements.txt"])
        if current == root:
            break
        current = current.parent

    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            if candidate.name == "requirements.txt":
                for line in candidate.read_text(encoding="utf-8").splitlines():
                    match = DEPENDENCY_NAME_RE.match(line)
                    if match and not line.lstrip().startswith(("#", "-")):
                        dependencies.add(normalized_name(match.group(1)))
                continue

            import tomllib

            document = tomllib.loads(candidate.read_text(encoding="utf-8"))
            project = document.get("project", {})
            groups = [project.get("dependencies", [])]
            groups.extend(project.get("optional-dependencies", {}).values())
            poetry = document.get("tool", {}).get("poetry", {}).get("dependencies", {})
            groups.append(poetry.keys())
            for group in groups:
                for item in group:
                    match = DEPENDENCY_NAME_RE.match(str(item))
                    if match and normalized_name(match.group(1)) != "python":
                        dependencies.add(normalized_name(match.group(1)))
        except (ImportError, OSError, ValueError, TypeError):
            continue
    return dependencies


def import_roots(node: ast.Import | ast.ImportFrom) -> list[str]:
    if isinstance(node, ast.Import):
        return [alias.name.split(".")[0] for alias in node.names]
    if node.level or not node.module:
        return []
    return [node.module.split(".")[0]]


def call_target(call: ast.Call) -> str:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        parts = [call.func.attr]
        current = call.func.value
        while isinstance(current, ast.Attribute):
            parts.append(current.attr)
            current = current.value
        if isinstance(current, ast.Name):
            parts.append(current.id)
        return ".".join(reversed(parts))
    return "<call>"


def identity_wrapper(node: ast.FunctionDef | ast.AsyncFunctionDef) -> ast.Call | None:
    if isinstance(node, ast.AsyncFunctionDef) or node.decorator_list or node.returns is not None:
        return None
    if getattr(node, "type_params", None):
        return None
    if len(node.body) != 1 or not isinstance(node.body[0], ast.Return) or not isinstance(node.body[0].value, ast.Call):
        return None
    if node.args.vararg or node.args.kwarg or node.args.kwonlyargs or node.args.defaults or node.args.kw_defaults:
        return None
    parameters = [*node.args.posonlyargs, *node.args.args]
    call = node.body[0].value
    if call.keywords or len(call.args) != len(parameters):
        return None
    if not all(isinstance(argument, ast.Name) and argument.id == parameter.arg for argument, parameter in zip(call.args, parameters)):
        return None
    if call_target(call).split(".")[-1] == node.name:
        return None
    return call


def log_statement(node: ast.stmt) -> bool:
    return (
        isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Attribute)
        and node.value.func.attr.lower() in LOG_METHODS
    )


def explicit_predicate_outcome(handler: ast.ExceptHandler, parents: dict[ast.AST, ast.AST]) -> bool:
    parent = parents.get(handler)
    if not isinstance(parent, ast.Try) or not handler.body or not isinstance(handler.body[-1], ast.Return):
        return False
    fallback = handler.body[-1].value
    if not isinstance(fallback, ast.Constant) or not isinstance(fallback.value, bool):
        return False
    function = next(
        (ancestor for ancestor in ancestors(parent, parents) if isinstance(ancestor, (ast.FunctionDef, ast.AsyncFunctionDef))),
        None,
    )
    if function is None or not function.name.startswith(("is_", "has_", "can_", "supports_", "exists_")):
        return False
    return any(
        isinstance(statement, ast.Return)
        and isinstance(statement.value, ast.Constant)
        and isinstance(statement.value.value, bool)
        and statement.value.value is not fallback.value
        for statement in parent.body
    )


def safe_fallback(node: ast.AST | None) -> bool:
    if isinstance(node, ast.Constant):
        return isinstance(node.value, (str, int, float, bool)) or node.value is None
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        return len(node.elts) == 0
    if isinstance(node, ast.Dict):
        if not node.keys:
            return True
        for key, value in zip(node.keys, node.values):
            if isinstance(key, ast.Constant) and str(key.value).lower() in {"ok", "success", "status"}:
                if value is not None and isinstance(value, ast.Constant) and (value.value is True or str(value.value).lower() in {"ok", "success"}):
                    return True
    return False


def scan_tree(root: Path, file_path: Path, source: str, tree: ast.AST) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    lines = source.splitlines(keepends=True)
    parents = parent_map(tree)
    roots = project_roots(root, file_path)
    dependencies = declared_dependencies(root, file_path)
    stdlib_modules = getattr(sys, "stdlib_module_names", set(sys.builtin_module_names))

    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if under_type_checking(node, parents) or optional_import(node, parents) or platform_conditional(node, parents):
                continue
            for module in import_roots(node):
                if module in stdlib_modules or module_on_disk(module, roots) or normalized_name(module) in dependencies:
                    continue
                findings.append(
                    finding(
                        root=root,
                        file_path=file_path,
                        source=source,
                        lines=lines,
                        node=node,
                        anchor=f"module:{module}",
                        rule_id="dependency.unresolved",
                        classification="defect",
                        confidence="C2",
                        risk="R2",
                        maximum_action="observe",
                        message=f"Module '{module}' is not resolvable from safe project/interpreter search roots",
                        evidence=["Python AST import extraction", "no standard-library, local, installed, or same-name declared dependency found"],
                        unknown=["distribution names can differ from import names; no package should be installed from this finding alone"],
                    )
                )

        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not isinstance(parents.get(node), ast.ClassDef):
            call = identity_wrapper(node)
            if call is not None:
                findings.append(
                    finding(
                        root=root,
                        file_path=file_path,
                        source=source,
                        lines=lines,
                        node=node,
                        anchor=f"function:{node.name}",
                        rule_id="structure.pass-through-wrapper",
                        classification="waste_candidate",
                        confidence="C1",
                        risk="R2",
                        maximum_action="observe",
                        message=f"Function '{node.name}' forwards unchanged arguments to '{call_target(call)}'",
                        evidence=["Python AST confirms one return call with identity argument mapping"],
                        unknown=["Python exports, decorators, dynamic references, and repository-wide callers are not proven"],
                    )
                )

        if isinstance(node, ast.ExceptHandler):
            body = node.body
            if (
                body
                and isinstance(body[-1], ast.Return)
                and safe_fallback(body[-1].value)
                and all(log_statement(item) for item in body[:-1])
                and not explicit_predicate_outcome(node, parents)
            ):
                findings.append(
                    finding(
                        root=root,
                        file_path=file_path,
                        source=source,
                        lines=lines,
                        node=body[-1],
                        anchor=structural_anchor(node, parents, "except-fallback"),
                        rule_id="data.hidden-catch-fallback",
                        classification="context_conflict",
                        confidence="C2",
                        risk="R3",
                        maximum_action="observe",
                        message="Except handler converts failure into a safe-looking return value",
                        evidence=["exception path ends in a literal or empty success-looking fallback"],
                        unknown=["caller contract and whether the fallback is intentionally visible"],
                    )
                )
            elif body and all(isinstance(item, ast.Pass) or log_statement(item) for item in body):
                log_only = any(log_statement(item) for item in body)
                findings.append(
                    finding(
                        root=root,
                        file_path=file_path,
                        source=source,
                        lines=lines,
                        node=node,
                        anchor=structural_anchor(node, parents, "except-suppressed"),
                        rule_id="errors.suppressed",
                        classification="context_conflict",
                        confidence="C2",
                        risk="R2",
                        maximum_action="observe",
                        message="Except handler only logs or passes before control continues" if log_only else "Except handler only passes before control continues",
                        evidence=["AST handler body contains no return, raise, retry, or recovery operation"],
                        unknown=["whether this is an intentional best-effort boundary"],
                    )
                )
    return findings


def scan_file(root: Path, raw_path: str) -> tuple[list[dict[str, Any]], dict[str, str] | None, str | None]:
    candidate = (root / raw_path.lstrip("@")).resolve()
    display = Path(os.path.relpath(candidate, root)).as_posix()
    if not is_inside(root, candidate):
        return [], {"filePath": display, "reason": "path resolves outside the project root"}, None
    if not candidate.is_file():
        return [], {"filePath": display, "reason": "file does not exist or is not a file"}, None
    if candidate.suffix.lower() != ".py":
        return [], {"filePath": display, "reason": "unsupported file extension"}, None
    if candidate.stat().st_size > MAX_FILE_BYTES:
        return [], {"filePath": display, "reason": f"file exceeds {MAX_FILE_BYTES} bytes"}, None
    try:
        source = candidate.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as error:
        return [], {"filePath": display, "reason": f"cannot read UTF-8 source: {error}"}, None
    if re.search(r"(?:^|/)(?:dist|build|coverage|vendor|generated)(?:/|$)", display, re.I) or re.search(r"(?:@generated|generated file|do not edit)", source[:500], re.I):
        return [], {"filePath": display, "reason": "generated or vendor-like file"}, None
    try:
        tree = ast.parse(source, filename=str(candidate))
    except SyntaxError:
        return [], {"filePath": display, "reason": "file has Python syntax diagnostics"}, None
    return scan_tree(root, candidate, source, tree), None, display


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("usage: python_helper.py ROOT [PATH ...]")
    root = Path(sys.argv[1]).resolve(strict=True)
    findings: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    scanned: list[str] = []
    for raw_path in sys.argv[2:]:
        file_findings, file_skip, display = scan_file(root, raw_path)
        findings.extend(file_findings)
        if file_skip:
            skipped.append(file_skip)
        if display:
            scanned.append(display)
    findings.sort(key=lambda item: (item["filePath"], item["line"], item["ruleId"]))
    print(
        json.dumps(
            {
                "engine": "python-ast",
                "engineVersion": platform.python_version(),
                "scannedFiles": sorted(set(scanned)),
                "findings": findings,
                "skipped": skipped,
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
