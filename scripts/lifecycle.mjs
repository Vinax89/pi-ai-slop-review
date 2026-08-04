#!/usr/bin/env node
import { constants as fsConstants, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, closeSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

function assertNoSymlinkPath(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`refusing symlinked lifecycle path: ${candidate}`);
    } catch (error) {
      if (error?.code === "ENOENT") {
        // Missing path components are safe until they are created below a checked parent.
      } else if (error instanceof Error && error.message.startsWith("refusing symlinked lifecycle path:")) {
        throw error;
      } else {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
function withTargetLock(target, operation) {
  const lockPath = path.join(path.dirname(path.resolve(target)), `.ai-slop-${path.basename(target)}.lock`);
  assertNoSymlinkPath(lockPath);
  let fd;
  try {
    fd = openSync(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("another lifecycle operation is already in progress");
    throw error;
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    return operation();
  } finally {
    closeSync(fd);
    assertNoSymlinkPath(lockPath);
    rmSync(lockPath, { force: true });
  }
}


function assertSafeTarget(root, target) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (relative !== "ai-slop") throw new Error("refusing to manage an unexpected extension path");
  assertNoSymlinkPath(absoluteRoot);
  assertNoSymlinkPath(absoluteTarget);
  if (existsSync(absoluteTarget) && !lstatSync(absoluteTarget).isDirectory()) throw new Error("extension target is not a directory");
}

function safeManifest(target) {
  const manifestPath = path.join(target, "package.json");
  assertNoSymlinkPath(manifestPath);
  if (!existsSync(manifestPath) || !lstatSync(manifestPath).isFile()) throw new Error("extension package manifest is not a regular file");
  const fd = openSync(manifestPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

function safeMarker(target, remove = false) {
  const marker = path.join(target, ".disabled");
  assertNoSymlinkPath(marker);
  if (remove) {
    if (existsSync(marker)) {
      if (lstatSync(marker).isSymbolicLink()) throw new Error("refusing to manage a symlinked lifecycle marker");
      rmSync(marker, { force: true });
    }
    return;
  }
  const fd = openSync(marker, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, `${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
}

function copyPackage(source, destination) {
  assertNoSymlinkPath(source);
  if (!existsSync(path.join(source, "package.json")) || !existsSync(path.join(source, "index.ts"))) throw new Error("source is not a Pi AI-slop extension package");
  if (!lstatSync(path.join(source, "package.json")).isFile() || !lstatSync(path.join(source, "index.ts")).isFile()) throw new Error("source package markers must be regular files");
  cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(source, entry);
      if (relative.split(path.sep).some((part) => ["node_modules", ".git", ".disabled", "__pycache__"].includes(part))) return false;
      if (lstatSync(entry).isSymbolicLink()) throw new Error(`source package contains a symlink: ${relative}`);
      return true;
    },
  });
}

function install(source, root, target) {
  assertSafeTarget(root, target);
  const resolvedSource = path.resolve(source);
  assertNoSymlinkPath(resolvedSource);
  if (resolvedSource === path.resolve(target)) throw new Error("install/update source must differ from the active target");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertSafeTarget(root, target);
  const stage = path.join(root, `.ai-slop-stage-${process.pid}`);
  const backup = path.join(root, `.ai-slop-backup-${process.pid}`);
  assertNoSymlinkPath(stage);
  assertNoSymlinkPath(backup);
  rmSync(stage, { recursive: true, force: true });
  rmSync(backup, { recursive: true, force: true });
  let backupMoved = false;
  let promoted = false;
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
    const stagedManifest = safeManifest(stage);
    if (typeof stagedManifest.version !== "string" || !stagedManifest.version) throw new Error("staged package manifest has no valid version");
    if (existsSync(target)) {
      assertSafeTarget(root, target);
      renameSync(target, backup);
      assertNoSymlinkPath(backup);
      backupMoved = true;
    }
    assertNoSymlinkPath(stage);
    assertSafeTarget(root, target);
    renameSync(stage, target);
    assertSafeTarget(root, target);
    promoted = true;
    const manifest = safeManifest(target);
    if (typeof manifest.version !== "string" || !manifest.version) throw new Error("promoted package manifest has no valid version");
    if (backupMoved) {
      assertNoSymlinkPath(backup);
      rmSync(backup, { recursive: true, force: true });
    }
    return { action: "install", target, version: manifest.version };
  } catch (error) {
    let rollbackError;
    try {
      assertNoSymlinkPath(stage);
      rmSync(stage, { recursive: true, force: true });
      if (promoted) {
        assertSafeTarget(root, target);
        rmSync(target, { recursive: true, force: true });
      }
      if (backupMoved && !existsSync(target) && existsSync(backup)) {
        assertNoSymlinkPath(target);
        assertNoSymlinkPath(backup);
        renameSync(backup, target);
        assertSafeTarget(root, target);
      }
    } catch (restoreError) {
      rollbackError = restoreError;
    }
    if (rollbackError) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; lifecycle rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    throw error;
  }
}
function status(target) {
  assertSafeTarget(path.dirname(target), target);
  if (!existsSync(target)) return { installed: false, target };
  const manifest = safeManifest(target);
  const marker = path.join(target, ".disabled");
  assertNoSymlinkPath(marker);
  return { installed: true, enabled: !existsSync(marker), target, version: manifest.version };
}

const { action, values, root, target } = parseArguments(process.argv.slice(2));
assertSafeTarget(root, target);
mkdirSync(root, { recursive: true, mode: 0o700 });
const result = withTargetLock(target, () => {
  assertSafeTarget(root, target);
  if (action === "install" || action === "update") {
    const installed = install(values[0] ?? PACKAGE_ROOT, root, target);
    installed.action = action;
    return installed;
  }
  if (action === "disable") {
    if (!existsSync(target)) throw new Error("extension is not installed");
    safeMarker(target);
    return { action, ...status(target) };
  }
  if (action === "enable") {
    if (!existsSync(target)) throw new Error("extension is not installed");
    safeMarker(target, true);
    return { action, ...status(target) };
  }
  if (action === "uninstall") {
    assertNoSymlinkPath(target);
    rmSync(target, { recursive: true, force: true });
    return { action, installed: false, target, statePreserved: true };
  }
  if (action === "purge-state") {
    const expectedRoot = path.join(homedir(), ".pi", "agent", "ai-slop");
    const stateRoot = process.env.PI_AI_SLOP_LIFECYCLE_TEST === "1" ? path.join(root, ".state") : expectedRoot;
    assertNoSymlinkPath(stateRoot);
    rmSync(stateRoot, { recursive: true, force: true });
    return { action, stateRemoved: true, stateRoot };
  }
  if (action === "status") return status(target);
  throw new Error(`unknown lifecycle action '${action}'`);
});
process.stdout.write(`${JSON.stringify(result)}\n`);
