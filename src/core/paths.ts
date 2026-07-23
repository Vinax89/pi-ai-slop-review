import { existsSync } from "node:fs";
import path from "node:path";

export function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function nearestExistingParent(candidate: string): string {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}
