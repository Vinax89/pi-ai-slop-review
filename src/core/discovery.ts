import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const EXCLUDED_DIRECTORIES = new Set([".git", ".hg", ".svn", ".venv", "venv", "node_modules", "dist", "build", "coverage", "vendor"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".md"]);
const MANIFESTS = new Set(["package.json", "pyproject.toml"]);

export function discoverRepositoryFiles(rootDir: string, maxFiles: number): { paths: string[]; truncated: boolean } {
  const root = realpathSync(rootDir);
  const paths: string[] = [];
  const queue = [root];
  let truncated = false;
  while (queue.length) {
    const directory = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (paths.length >= maxFiles) {
        truncated = true;
        break;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && !MANIFESTS.has(entry.name)) continue;
      try {
        if (statSync(absolute).size > 1024 * 1024) continue;
      } catch {
        continue;
      }
      paths.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
    if (truncated) break;
  }
  return { paths: paths.sort(), truncated };
}
