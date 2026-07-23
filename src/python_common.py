from __future__ import annotations

import ast
from collections.abc import Iterator
from pathlib import Path


def is_inside(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def ancestors(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> Iterator[ast.AST]:
    current = parents.get(node)
    while current is not None:
        yield current
        current = parents.get(current)
