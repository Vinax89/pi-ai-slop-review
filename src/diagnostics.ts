import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

function commandAvailable(command: string): boolean {
  if (path.isAbsolute(command)) return existsSync(command);
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  return pathValue.split(path.delimiter).some((directory) => extensions.some((extension) => existsSync(path.join(directory, `${command}${extension}`))));
}

export function diagnose(rootDir: string, loaded: LoadedConfig): DiagnosticReport {
  const checks: DiagnosticReport["checks"] = [];
  const pythonCommand = process.env.PI_AI_SLOP_PYTHON ?? "python3";
  const python = spawnSync(pythonCommand, ["-I", "-S", "--version"], { encoding: "utf8", timeout: 5_000, env: { PATH: process.env.PATH } });
  checks.push({ name: "python", ok: python.status === 0, detail: (python.stdout || python.stderr || python.error?.message || "unavailable").trim() });
  try {
    const rules = loadRulePolicies();
    checks.push({ name: "rules", ok: rules.size > 0, detail: `${rules.size} executable rule policy/policies` });
  } catch (error) {
    checks.push({ name: "rules", ok: false, detail: (error as Error).message });
  }
  try {
    const state = new StateStore(rootDir).load();
    checks.push({ name: "state", ok: true, detail: `revision ${state.revision}, ${Object.keys(state.baselines).length} baseline(s)` });
  } catch (error) {
    checks.push({ name: "state", ok: false, detail: (error as Error).message });
  }
  try {
    const graph = new GraphStore(rootDir);
    const statistics = graph.statistics();
    graph.close();
    checks.push({ name: "graph", ok: true, detail: `${statistics.files} files, ${statistics.nodes} nodes, ${statistics.edges} edges` });
  } catch (error) {
    checks.push({ name: "graph", ok: false, detail: (error as Error).message });
  }
  for (const [language, command] of Object.entries(loaded.config.execution.lspServers)) {
    checks.push({ name: `lsp:${language}`, ok: commandAvailable(command[0]), detail: commandAvailable(command[0]) ? command.join(" ") : `${command[0]} not found on PATH` });
  }
  for (const report of [
    ...loaded.config.providers.sarif.map((reportPath) => ({ kind: "sarif", path: reportPath })),
    ...loaded.config.providers.analyzerReports,
    ...loaded.config.providers.coverageReports,
  ]) {
    const absolute = path.resolve(rootDir, report.path);
    checks.push({ name: `report:${report.kind}`, ok: existsSync(absolute), detail: report.path });
  }
  return {
    ok: checks.every((check) => check.ok),
    node: process.version,
    python: checks.find((check) => check.name === "python")?.detail ?? "unavailable",
    networkEnabled: loaded.config.network.enabled,
    executionTrusted: loaded.config.execution.trusted,
    configurationSources: loaded.sources,
    warnings: loaded.warnings,
    checks,
  };
}

export function formatDiagnostics(report: DiagnosticReport): string {
  return [
    `AI-slop diagnostics: ${report.ok ? "healthy" : "attention required"}`,
    `Node ${report.node}; Python ${report.python}`,
    `Network ${report.networkEnabled ? "enabled" : "disabled"}; project execution ${report.executionTrusted ? "configured" : "disabled"}`,
    ...report.checks.map((check) => `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`),
    ...report.warnings.map((warning) => `WARN ${warning}`),
  ].join("\n");
}
