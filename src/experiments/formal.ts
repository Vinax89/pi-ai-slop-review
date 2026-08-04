import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { AiSlopConfig } from "../core/config.ts";
import { isExactConfiguredCommand, restrictedRuntime } from "../core/execution.ts";
import { fingerprint } from "../core/schema.ts";
import { SCHEMA_VERSION, type ExperimentSpec, type FormalVerificationResult } from "../types.ts";
import { expressionEquivalenceSmt } from "./expression.ts";

function isolatedStdin(command: string[], input: string, config: AiSlopConfig, signal?: AbortSignal): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const runtime = restrictedRuntime(command);
    const hiddenFiles = command.filter((part) => path.isAbsolute(part) && part.startsWith(`${path.resolve("/tmp")}${path.sep}`) && existsSync(part));
    const hiddenDirectories = [...new Set(hiddenFiles.flatMap((filePath) => {
      const directories: string[] = [];
      let current = path.dirname(filePath);
      while (current !== "/tmp" && current.startsWith("/tmp/")) {
        directories.push(current);
        current = path.dirname(current);
      }
      return directories;
    }))].sort((left, right) => left.length - right.length);
    const args = [
      ...runtime.args, "--dev", "/dev", "--proc", "/proc",
      "--tmpfs", "/tmp", "--dir", "/tmp/home",
      ...hiddenDirectories.flatMap((directory) => ["--dir", directory]),
      ...hiddenFiles.flatMap((filePath) => ["--ro-bind", filePath, filePath]),
      "--clearenv",
      "--setenv", "PATH", runtime.path, "--setenv", "HOME", "/tmp/home", "--setenv", "TMPDIR", "/tmp",
      "--", ...command,
    ];
    const child = spawn("bwrap", args, { shell: false, stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } });
    let output = "";
    const collect = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.length > config.limits.maxOutputBytes) {
        child.kill("SIGTERM");
        reject(new Error("formal engine output exceeded configured limit"));
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output: output.slice(-64 * 1024) }));
    const timer = setTimeout(() => child.kill("SIGTERM"), config.limits.commandTimeoutMs);
    child.on("close", () => clearTimeout(timer));
    signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
    child.stdin.end(input);
  });
}

function abstained(engine: FormalVerificationResult["engine"], diagnostic: string, assumptions: string[]): FormalVerificationResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: fingerprint("formal", { engine, diagnostic, assumptions }),
    engine,
    status: "abstained",
    assumptions,
    output: diagnostic,
  };
}

export async function runSmtEquivalence(
  spec: ExperimentSpec,
  command: string[],
  config: AiSlopConfig,
  trustedProject: boolean,
  signal?: AbortSignal,
): Promise<FormalVerificationResult> {
  const assumptions = ["SMT-LIB integer/boolean semantics", "side-effect-free expressions", "solver command runs in a network-isolated, secret-scrubbed Bubblewrap process"];
  if (!config.experiments.smt) return abstained("smt", "SMT experiment is disabled", assumptions);
  if (!trustedProject || !config.execution.trusted) return abstained("smt", "SMT execution requires project trust and execution.trusted", assumptions);
  if (!isExactConfiguredCommand(command, config.execution.commands)) return abstained("smt", "SMT command is not an exact execution.commands entry", assumptions);
  try {
    const script = expressionEquivalenceSmt(spec);
    const result = await isolatedStdin(command, script, config, signal);
    if (result.code !== 0) return abstained("smt", `SMT engine exited with code ${String(result.code)}: ${result.output}`, assumptions);
    const first = result.output.trim().split(/\r?\n/)[0];
    const status: FormalVerificationResult["status"] = first === "unsat" ? "verified" : first === "sat" ? "refuted" : "unknown";
    return {
      schemaVersion: SCHEMA_VERSION,
      id: fingerprint("formal", { command, script, output: result.output, status }),
      engine: "smt",
      status,
      assumptions,
      output: result.output,
      counterexample: status === "refuted" ? result.output : undefined,
    };
  } catch (error) {
    return abstained("smt", error instanceof Error ? error.message : String(error), assumptions);
  }
}

export async function runTranslationValidation(
  llvmTransformation: string,
  command: string[],
  config: AiSlopConfig,
  trustedProject: boolean,
  signal?: AbortSignal,
): Promise<FormalVerificationResult> {
  const assumptions = [
    "input is an Alive2-compatible LLVM IR transformation",
    "the configured validator defines the supported LLVM memory and undefined-behavior model",
    "validator runs in a network-isolated, secret-scrubbed Bubblewrap process",
  ];
  if (!config.experiments.translationValidation) return abstained("translation-validation", "translation validation experiment is disabled", assumptions);
  if (!trustedProject || !config.execution.trusted) return abstained("translation-validation", "translation validation requires project trust and execution.trusted", assumptions);
  if (!isExactConfiguredCommand(command, config.execution.commands)) return abstained("translation-validation", "translation validator command is not an exact execution.commands entry", assumptions);
  if (Buffer.byteLength(llvmTransformation) > 2 * 1024 * 1024) return abstained("translation-validation", "LLVM transformation exceeds 2 MiB", assumptions);
  try {
    const result = await isolatedStdin(command, llvmTransformation, config, signal);
    const verified = result.code === 0 && /Transformation seems to be correct|0 incorrect transformations/i.test(result.output);
    const refuted = /ERROR|incorrect transformation|mismatch/i.test(result.output);
    const status: FormalVerificationResult["status"] = verified ? "verified" : refuted ? "refuted" : "unknown";
    return {
      schemaVersion: SCHEMA_VERSION,
      id: fingerprint("formal", { command, llvmTransformation: fingerprint("ir", llvmTransformation), output: result.output, status }),
      engine: "translation-validation",
      status,
      assumptions,
      output: result.output,
      counterexample: status === "refuted" ? result.output : undefined,
    };
  } catch (error) {
    return abstained("translation-validation", error instanceof Error ? error.message : String(error), assumptions);
  }
}
