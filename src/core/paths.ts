import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

function hasSymlinkComponent(root: string, candidate: string): boolean {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  if (!isLexicallyInside(absoluteRoot, absoluteCandidate)) return true;
  let current = absoluteCandidate;
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    if (current === absoluteRoot) return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function isLexicallyInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isInside(root: string, candidate: string): boolean {
  return isLexicallyInside(path.resolve(root), path.resolve(candidate)) && !hasSymlinkComponent(root, candidate);
}

export function hasSymlinkPath(candidate: string): boolean {
  let current = path.resolve(candidate);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export function nearestExistingParent(candidate: string): string {
  let current = path.resolve(candidate);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}
