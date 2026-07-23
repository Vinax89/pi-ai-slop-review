#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

function parseArguments(argv) {
  const values = [...argv];
  const action = values.shift() ?? "status";
  let root = path.join(homedir(), ".pi", "agent", "extensions");
  const rootIndex = values.indexOf("--root");
  if (rootIndex >= 0) {
    if (process.env.PI_AI_SLOP_LIFECYCLE_TEST !== "1") throw new Error("--root is restricted to the lifecycle test harness");
    root = path.resolve(values[rootIndex + 1]);
    values.splice(rootIndex, 2);
  }
  return { action, values, root, target: path.join(root, "ai-slop") };
}

function assertSafeTarget(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative !== "ai-slop" || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("refusing to manage an unexpected extension path");
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("refusing to manage a symlinked extension target");
}

function copyPackage(source, destination) {
  if (!existsSync(path.join(source, "package.json")) || !existsSync(path.join(source, "index.ts"))) throw new Error("source is not a Pi AI-slop extension package");
  cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(source, entry);
      return !relative.split(path.sep).some((part) => ["node_modules", ".git", ".disabled", "__pycache__"].includes(part));
    },
  });
}

function install(source, root, target) {
  assertSafeTarget(root, target);
  const resolvedSource = path.resolve(source);
  if (resolvedSource === path.resolve(target)) throw new Error("install/update source must differ from the active target");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stage = path.join(root, `.ai-slop-stage-${process.pid}`);
  const backup = path.join(root, `.ai-slop-backup-${process.pid}`);
  rmSync(stage, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  try {
    copyPackage(resolvedSource, stage);
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const installed = spawnSync(npm, ["ci", "--ignore-scripts", "--omit=dev", "--no-audit"], {
      cwd: stage,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, npm_config_ignore_scripts: "true" },
    });
    if (installed.status !== 0) throw new Error(`dependency installation failed: ${installed.stderr || installed.stdout}`);
    if (existsSync(target)) renameSync(target, backup);
    renameSync(stage, target);
    rmSync(backup, { recursive: true, force: true });
    return { action: "install", target, version: JSON.parse(readFileSync(path.join(target, "package.json"), "utf8")).version };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (!existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw error;
  }
}

function status(target) {
  if (!existsSync(target)) return { installed: false, target };
  assertSafeTarget(path.dirname(target), target);
  const manifest = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"));
  return { installed: true, enabled: !existsSync(path.join(target, ".disabled")), target, version: manifest.version };
}

const { action, values, root, target } = parseArguments(process.argv.slice(2));
assertSafeTarget(root, target);
let result;
if (action === "install" || action === "update") {
  result = install(values[0] ?? PACKAGE_ROOT, root, target);
  result.action = action;
} else if (action === "disable") {
  if (!existsSync(target)) throw new Error("extension is not installed");
  writeFileSync(path.join(target, ".disabled"), `${new Date().toISOString()}\n`, { mode: 0o600 });
  result = { action, ...status(target) };
} else if (action === "enable") {
  rmSync(path.join(target, ".disabled"), { force: true });
  result = { action, ...status(target) };
} else if (action === "uninstall") {
  rmSync(target, { recursive: true, force: true });
  result = { action, installed: false, target, statePreserved: true };
} else if (action === "purge-state") {
  const expectedRoot = path.join(homedir(), ".pi", "agent", "ai-slop");
  const stateRoot = process.env.PI_AI_SLOP_LIFECYCLE_TEST === "1" ? path.join(root, ".state") : expectedRoot;
  rmSync(stateRoot, { recursive: true, force: true });
  result = { action, stateRemoved: true, stateRoot };
} else if (action === "status") result = status(target);
else throw new Error(`unknown lifecycle action '${action}'`);
process.stdout.write(`${JSON.stringify(result)}\n`);
