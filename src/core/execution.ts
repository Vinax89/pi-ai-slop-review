import { accessSync, constants, existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

export function splitCommand(value: string): string[] {
  return (value.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [])
    .map((part) => part.startsWith("\"") ? part.slice(1, -1) : part);
}

export function isExactConfiguredCommand(command: string[], configured: string[]): boolean {
  if (!command.length || !command[0] || command.some((part) => part.includes("\0"))) return false;
  return configured.some((value) => {
    const expected = splitCommand(value);
    return expected.length === command.length && expected.every((part, index) => part === command[index]);
  });
}

function executablePath(command: string, workspace?: string): string | undefined {
  const candidates = path.isAbsolute(command)
    ? [command]
    : command.includes(path.sep)
      ? [path.resolve(workspace ?? process.cwd(), command)]
      : (process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(path.delimiter).map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const stats = lstatSync(candidate);
    if (!stats.isFile() && !stats.isSymbolicLink()) continue;
    accessSync(candidate, constants.X_OK);
    return candidate;
  }
  return undefined;
}

function parentDirectories(target: string): string[] {
  const directories: string[] = [];
  let current = path.dirname(target);
  while (current !== path.dirname(current)) {
    directories.push(current);
    current = path.dirname(current);
  }
  return directories.reverse();
}

function systemMounts(): string[] {
  const args: string[] = [];
  if (existsSync("/usr")) args.push("--ro-bind", "/usr", "/usr");
  for (const target of ["/bin", "/sbin", "/lib", "/lib64"]) {
    if (!existsSync(target)) continue;
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) args.push("--symlink", readlinkSync(target), target);
    else args.push("--ro-bind", target, target);
  }
  return args;
}

export function restrictedRuntime(command: string[], workspace?: string): { args: string[]; path: string } {
  const resolved = executablePath(command[0], workspace);
  if (!resolved) throw new Error(`configured executable was not found: ${command[0]}`);
  const real = realpathSync(resolved);
  const runtimePath = new Set(["/usr/local/bin", "/usr/bin", "/bin", path.dirname(resolved)]);
  const args = [
    "--die-with-parent",
    "--unshare-net",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    ...systemMounts(),
  ];
  const systemRuntime = ["/usr/", "/bin/", "/sbin/", "/lib/", "/lib64/"].some((prefix) => resolved.startsWith(prefix));
  const insideWorkspace = workspace !== undefined && (resolved === workspace || resolved.startsWith(`${workspace}${path.sep}`));
  if (!systemRuntime && !insideWorkspace) {
    for (const directory of parentDirectories(resolved)) args.push("--dir", directory);
    args.push("--ro-bind", real, resolved);
  }
  return { args, path: [...runtimePath].join(path.delimiter) };
}
