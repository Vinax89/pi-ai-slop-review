import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import { isInside, normalizePath } from "../core/paths.ts";
import { sha256 } from "../core/schema.ts";
import type { SourceRange } from "../types.ts";

export function safeProjectFile(rootDir: string, rawPath: string, maxBytes = 16 * 1024 * 1024): { absolutePath: string; filePath: string; source: string } | undefined {
  const root = realpathSync(rootDir);
  let decoded = rawPath;
  if (decoded.startsWith("file://")) {
    try {
      decoded = new URL(decoded).pathname;
    } catch {
      // Invalid file URLs are rejected rather than reinterpreted as local paths.
      return undefined;
    }
  }
  const absolute = path.isAbsolute(decoded) ? path.resolve(decoded) : path.resolve(root, decoded.replace(/^@/, ""));
  if (!isInside(root, absolute) || !existsSync(absolute)) return undefined;
  const real = realpathSync(absolute);
  const stats = statSync(real);
  if (!isInside(root, real) || !stats.isFile() || stats.size > maxBytes) return undefined;
  try {
    return { absolutePath: real, filePath: normalizePath(path.relative(root, real)), source: readFileSync(real, "utf8") };
  } catch {
    // Unreadable files provide no evidence; callers surface the missing provider input.
    return undefined;
  }
}

export function offsetRange(filePath: string, source: string, start: number, end: number): SourceRange {
  const boundedStart = Math.min(Math.max(0, start), source.length);
  const boundedEnd = Math.min(Math.max(boundedStart, end), source.length);
  const prefix = source.slice(0, boundedStart);
  const lastNewline = prefix.lastIndexOf("\n");
  return {
    filePath,
    line: prefix.split("\n").length,
    column: boundedStart - lastNewline,
    start: boundedStart,
    end: boundedEnd,
    sourceHash: sha256(source),
  };
}

export function sourceRange(
  filePath: string,
  source: string,
  startLine = 1,
  startColumn = 1,
  endLine = startLine,
  endColumn = startColumn,
): SourceRange {
  const lines = source.split(/(?<=\n)/);
  const line = Math.min(Math.max(1, startLine), Math.max(1, lines.length));
  const finalLine = Math.min(Math.max(line, endLine), Math.max(1, lines.length));
  const lineText = lines[line - 1] ?? "";
  const finalLineText = lines[finalLine - 1] ?? "";
  const column = Math.min(Math.max(1, startColumn), lineText.length + 1);
  const finalColumn = Math.min(Math.max(1, endColumn), finalLineText.length + 1);
  const start = lines.slice(0, line - 1).reduce((total, value) => total + value.length, 0) + column - 1;
  const end = lines.slice(0, finalLine - 1).reduce((total, value) => total + value.length, 0) + finalColumn - 1;
  return {
    filePath,
    line,
    column,
    start,
    end: Math.max(start, end),
    sourceHash: sha256(source),
  };
}
