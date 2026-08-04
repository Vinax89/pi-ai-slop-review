import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { isInside } from "./core/paths.ts";
import { redactSensitive } from "./core/redaction.ts";
import type { LoadedConfig } from "./core/config.ts";
import { StateStore } from "./core/store.ts";
import { GraphStore } from "./graph/store.ts";
import { loadRulePolicies } from "./policy/rules.ts";

export interface DiagnosticReport {
  ok: boolean;
  node: string;
  python: string;
  networkEnabled: boolean;
  executionTrusted: boolean;
  configurationSources: string[];
  warnings: string[];
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}
export { redactSensitive };


function commandAvailable(command: string): boolean {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "").split(path.delimiter).flatMap((directory) => {
        const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
        return extensions.map((extension) => path.join(directory, `${command}${extension}`));
      });
  return candidates.some((candidate) => {
    try {
      return existsSync(candidate) && lstatSync(candidate).isFile() && (accessSync(candidate, constants.X_OK), true);
    } catch {
      return false;
    }
  });
}

export function diagnose(rootDir: string, loaded: LoadedConfig): DiagnosticReport {
  const checks: DiagnosticReport["checks"] = [];
  const pythonCommand = process.env.PI_AI_SLOP_PYTHON ?? "python3";
  const python = spawnSync(pythonCommand, ["-I", "-S", "--version"], { encoding: "utf8", timeout: 5_000, env: { PATH: process.env.PATH } });
  checks.push({ name: "python", ok: python.status === 0, detail: redactSensitive((python.stdout || python.stderr || python.error?.message || "unavailable").trim()) });
  try {
    const rules = loadRulePolicies();
    checks.push({ name: "rules", ok: rules.size > 0, detail: `${rules.size} executable rule policy/policies` });
  } catch (error) {
    checks.push({ name: "rules", ok: false, detail: redactSensitive((error as Error).message) });
  }
  try {
    const state = new StateStore(rootDir).load();
    checks.push({ name: "state", ok: true, detail: `revision ${state.revision}, ${Object.keys(state.baselines).length} baseline(s)` });
  } catch (error) {
    checks.push({ name: "state", ok: false, detail: redactSensitive((error as Error).message) });
  }
  try {
    const graph = new GraphStore(rootDir);
    const statistics = graph.statistics();
    graph.close();
    checks.push({ name: "graph", ok: true, detail: `${statistics.files} files, ${statistics.nodes} nodes, ${statistics.edges} edges` });
  } catch (error) {
    checks.push({ name: "graph", ok: false, detail: redactSensitive((error as Error).message) });
  }
  for (const [language, command] of Object.entries(loaded.config.execution.lspServers)) {
    const available = command.length > 0 && commandAvailable(command[0]);
    checks.push({ name: `lsp:${language}`, ok: available, detail: redactSensitive(available ? command.join(" ") : `${command[0] ?? "<missing>"} not found on PATH`) });
  }
  const root = realpathSync(rootDir);
  for (const report of [
    ...loaded.config.providers.sarif.map((reportPath) => ({ kind: "sarif", path: reportPath })),
    ...loaded.config.providers.analyzerReports,
    ...loaded.config.providers.coverageReports,
  ]) {
    const absolute = path.resolve(root, report.path);
    let available = false;
    try {
      const real = realpathSync(absolute);
      available = isInside(root, absolute) && isInside(root, real) && lstatSync(real).isFile();
    } catch {
      available = false;
    }
    checks.push({ name: `report:${report.kind}`, ok: available, detail: redactSensitive(report.path) });
  }
  const warnings = loaded.warnings.map(redactSensitive);
  return {
    ok: checks.every((check) => check.ok) && warnings.length === 0,
    node: process.version,
    python: checks.find((check) => check.name === "python")?.detail ?? "unavailable",
    networkEnabled: loaded.config.network.enabled,
    executionTrusted: loaded.config.execution.trusted,
    configurationSources: loaded.sources.map(redactSensitive),
    warnings,
    checks,
  };
}

export function formatDiagnostics(report: DiagnosticReport): string {
  return [
    `AI-slop diagnostics: ${report.ok ? "healthy" : "attention required"}`,
    `Node ${redactSensitive(report.node)}; Python ${redactSensitive(report.python)}`,
    `Network ${report.networkEnabled ? "enabled" : "disabled"}; project execution ${report.executionTrusted ? "configured" : "disabled"}`,
    ...report.checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${redactSensitive(check.name)}: ${redactSensitive(check.detail)}`),
    ...report.warnings.map((warning) => `WARN ${redactSensitive(warning)}`),
  ].join("\n");
}
