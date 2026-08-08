import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export const EXCLUDED_DIRECTORIES = new Set([".git", ".hg", ".svn", ".venv", ".next", "venv", "node_modules", "dist", "build", "coverage", "vendor"]);
export const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".py", ".md"]);
export const MANIFESTS = new Set(["package.json", "pyproject.toml"]);

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
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        if (!EXCLUDED_DIRECTORIES.has(entry.name) && !/(?:^|\/)\.[^/]+\/worktrees$/.test(relative)) queue.push(absolute);
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

/**
 * Project-relative source paths changed since git HEAD: tracked modifications
 * and renames (deleted files excluded) plus untracked files. Returns undefined
 * when git is unavailable or has no readable HEAD, and an empty array when git
 * works but nothing changed.
 */
export function changedSinceHead(rootDir: string): string[] | undefined {
  try {
    const run = (args: string[]): string[] => {
      const output = execFileSync("git", args, { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return output.split("\0").filter(Boolean);
    };
    const changed = new Set<string>();
    const statusRecords = run(["diff", "--name-status", "-z", "HEAD"]);
    for (let index = 0; index < statusRecords.length; index += 1) {
      const record = statusRecords[index];
      const tab = record.indexOf("\t");
      const status = tab === -1 ? record : record.slice(0, tab);
      const filePath = tab === -1 ? "" : record.slice(tab + 1);
      if (status.startsWith("R") || status.startsWith("C")) index += 1; // -z emits the rename source path as a separate record
      if (filePath && !status.startsWith("D")) changed.add(filePath);
    }
    for (const filePath of run(["ls-files", "-m", "-o", "--exclude-standard", "-z"])) changed.add(filePath);
    const root = realpathSync(rootDir);
    return [...changed]
      .filter((filePath) =>
        (SOURCE_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || MANIFESTS.has(path.basename(filePath))) &&
        existsSync(path.resolve(root, filePath)),
      )
      .sort();
  } catch {
    return undefined;
  }
}
