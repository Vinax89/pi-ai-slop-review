from __future__ import annotations

import ast
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tomllib
from typing import Any

MAX_FILE_BYTES = int(os.environ.get("PI_AI_SLOP_MAX_FILE_BYTES", str(1024 * 1024)))

sys.dont_write_bytecode = True
_COMMON_SPEC = importlib.util.spec_from_file_location("_pi_ai_slop_python_common", Path(__file__).with_name("python_common.py"))
if _COMMON_SPEC is None or _COMMON_SPEC.loader is None:
    raise RuntimeError("cannot load isolated Python common helpers")
_COMMON = importlib.util.module_from_spec(_COMMON_SPEC)
_COMMON_SPEC.loader.exec_module(_COMMON)
is_inside = _COMMON.is_inside
ancestors = _COMMON.ancestors


def offset(lines: list[str], line: int, byte_column: int) -> int:
    prefix = "".join(lines[: max(0, line - 1)])
    raw = lines[max(0, line - 1)].encode("utf-8") if lines else b""
    text = raw[:byte_column].decode("utf-8", errors="ignore")
    return len((prefix + text).encode("utf-16-le")) // 2


def qualified_name(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> str:
    names: list[str] = []
    current: ast.AST | None = node
    while current is not None:
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(current.name)
        current = parents.get(current)
    return ".".join(reversed(names))


def call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = call_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return "<dynamic>"


def signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    arguments = [argument.arg for argument in [*node.args.posonlyargs, *node.args.args]]
    if node.args.vararg:
        arguments.append(f"*{node.args.vararg.arg}")
    arguments.extend(argument.arg for argument in node.args.kwonlyargs)
    if node.args.kwarg:
        arguments.append(f"**{node.args.kwarg.arg}")
    return f"{node.name}({', '.join(arguments)})"


def scan(file_path: Path, source: str) -> dict[str, Any]:
    tree = ast.parse(source, filename=str(file_path))
    lines = source.splitlines(keepends=True)
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    declared_all: set[str] | None = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "__all__" for target in node.targets):
            if isinstance(node.value, (ast.List, ast.Tuple)) and all(isinstance(item, ast.Constant) and isinstance(item.value, str) for item in node.value.elts):
                declared_all = {item.value for item in node.value.elts}
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    function_nodes: dict[ast.AST, str] = {}

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            qualified = qualified_name(node, parents)
            top_level = isinstance(parents.get(node), ast.Module)
            exported = top_level and (node.name in declared_all if declared_all is not None else not node.name.startswith("_"))
            decorators = [call_name(item.func if isinstance(item, ast.Call) else item) for item in getattr(node, "decorator_list", [])]
            kind = "class" if isinstance(node, ast.ClassDef) else "test" if node.name.startswith("test") else "function"
            start = offset(lines, getattr(node, "lineno", 1), getattr(node, "col_offset", 0))
            end = offset(lines, getattr(node, "end_lineno", getattr(node, "lineno", 1)), getattr(node, "end_col_offset", 0))
            body_hash = hashlib.sha256(ast.dump(ast.Module(body=getattr(node, "body", []), type_ignores=[]), include_attributes=False).encode()).hexdigest()
            nodes.append({
                "kind": kind,
                "name": node.name,
                "qualifiedName": qualified,
                "start": start,
                "end": end,
                "exported": exported,
                "signature": signature(node) if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else node.name,
                "bodyHash": body_hash,
                "metadata": {"decorators": decorators, "async": isinstance(node, ast.AsyncFunctionDef)},
            })
            function_nodes[node] = qualified
            for decorator in decorators:
                if decorator.split(".")[-1].lower() in {"get", "post", "put", "patch", "delete", "route", "command", "task"}:
                    nodes.append({
                        "kind": "registration",
                        "name": decorator,
                        "qualifiedName": f"{qualified}@{decorator}",
                        "start": start,
                        "end": end,
                        "exported": False,
                        "metadata": {"framework": "decorator", "target": qualified},
                    })

        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif node.module:
                modules = [node.module]
            else:
                modules = [alias.name for alias in node.names]
            for module in modules:
                edges.append({"from": "<file>", "to": f"module:{module}", "kind": "imports", "confidence": "C2", "metadata": {"module": module, "level": getattr(node, "level", 0)}})
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        owner = next((parent for parent in ancestors(node, parents) if parent in function_nodes), None)
        source_name = function_nodes.get(owner, "<file>")
        target = call_name(node.func)
        edges.append({"from": source_name, "to": f"call:{target}", "kind": "calls", "confidence": "C1", "metadata": {"target": target}})
        if target.split(".")[-1].lower() in {"register", "route", "add_route", "add_api_route", "command", "task"}:
            if not any(item["kind"] == "registration" and item["name"] == target for item in nodes):
                start = offset(lines, getattr(node, "lineno", 1), getattr(node, "col_offset", 0))
                end = offset(lines, getattr(node, "end_lineno", getattr(node, "lineno", 1)), getattr(node, "end_col_offset", 0))
                nodes.append({
                    "kind": "registration",
                    "name": target,
                    "qualifiedName": target,
                    "start": start,
                    "end": end,
                    "exported": False,
                    "metadata": {"framework": "call-registration", "target": target},
                })
            edges.append({"from": source_name, "to": f"registration:{target}", "kind": "registers", "confidence": "C2", "metadata": {"target": target}})

    return {"nodes": nodes, "edges": edges}


def scan_pyproject(source: str) -> dict[str, Any]:
    document = tomllib.loads(source)
    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    groups: list[tuple[str, dict[str, Any]]] = []
    project = document.get("project", {})
    groups.extend([("script", project.get("scripts", {})), ("gui-script", project.get("gui-scripts", {}))])
    groups.extend((f"entry-point:{name}", entries) for name, entries in project.get("entry-points", {}).items())
    for group, entries in groups:
        if not isinstance(entries, dict):
            continue
        for name, target in entries.items():
            qualified = f"{group}:{name}"
            nodes.append({
                "kind": "registration",
                "name": str(name),
                "qualifiedName": qualified,
                "start": 0,
                "end": 0,
                "exported": True,
                "metadata": {"framework": "python-entry-point", "group": group, "target": str(target)},
            })
            edges.append({"from": "<file>", "to": f"registration:{qualified}", "kind": "registers", "confidence": "C3", "metadata": {"target": str(target)}})
    return {"nodes": nodes, "edges": edges}


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("usage: python_graph_helper.py ROOT PATH...")
    root = Path(sys.argv[1]).resolve(strict=True)
    results: dict[str, Any] = {}
    errors: dict[str, str] = {}
    for raw_path in sys.argv[2:]:
        candidate = (root / raw_path.lstrip("@")).resolve()
        display = candidate.relative_to(root).as_posix() if is_inside(root, candidate) else raw_path
        supported = candidate.suffix.lower() == ".py" or candidate.name == "pyproject.toml"
        if not is_inside(root, candidate) or not candidate.is_file() or not supported:
            errors[display] = "missing, unsupported, or outside project root"
            continue
        if candidate.stat().st_size > MAX_FILE_BYTES:
            errors[display] = f"file exceeds {MAX_FILE_BYTES} bytes"
            continue
        try:
            source = candidate.read_text(encoding="utf-8")
            results[display] = scan_pyproject(source) if candidate.name == "pyproject.toml" else scan(candidate, source)
        except (OSError, UnicodeError, SyntaxError, tomllib.TOMLDecodeError) as error:
            errors[display] = str(error)
    print(json.dumps({"files": results, "errors": errors}, separators=(",", ":")))

if __name__ == "__main__":
    main()
