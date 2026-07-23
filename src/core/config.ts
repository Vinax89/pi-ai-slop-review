import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { canonicalJson, sha256 } from "./schema.ts";

export interface VerificationCommandConfig {
  pattern: string;
  kind: "build" | "format" | "lint" | "typecheck" | "unit-test" | "integration-test" | "security" | "custom";
  authoritativeFor: string[];
}

export type AnalyzerReportKind = "eslint" | "ruff" | "pyright" | "knip";
export type CoverageReportKind = "lcov" | "coverage-py-json";

export interface AiSlopConfig {
  schemaVersion: 1;
  defaultScope: "session" | "delta";
  network: { enabled: boolean; registries: string[] };
  execution: { trusted: boolean; commands: string[]; lspServers: Record<string, string[]> };
  providers: {
    sarif: string[];
    analyzerReports: Array<{ kind: AnalyzerReportKind; path: string }>;
    coverageReports: Array<{ kind: CoverageReportKind; path: string }>;
  };
  lab: {
    enabled: boolean;
    criticalPatterns: string[];
    maxPatchBytes: number;
    maxCommands: number;
  };
  graph: {
    enabled: boolean;
    testPatterns: string[];
    specPatterns: string[];
    layers: Array<{ name: string; patterns: string[] }>;
    allowedEdges: string[];
  };
  experiments: Record<string, boolean>;
  verification: { commands: VerificationCommandConfig[] };
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    commandTimeoutMs: number;
    maxOutputBytes: number;
    maxFindings: number;
  };
}

export interface LoadedConfig {
  config: AiSlopConfig;
  hash: string;
  sources: string[];
  warnings: string[];
}

export const DEFAULT_CONFIG: AiSlopConfig = {
  schemaVersion: 1,
  defaultScope: "session",
  network: { enabled: false, registries: [] },
  execution: { trusted: false, commands: [], lspServers: {} },
  providers: { sarif: [], analyzerReports: [], coverageReports: [] },
  lab: {
    enabled: true,
    criticalPatterns: [
      "auth/**", "billing/**", "security/**", "migrations/**",
      "**/auth/**", "**/billing/**", "**/security/**", "**/migrations/**",
      "**/*money*", "**/*payment*"
    ],
    maxPatchBytes: 1024 * 1024,
    maxCommands: 20,
  },
  graph: {
    enabled: true,
    testPatterns: ["**/test/**", "**/tests/**", "**/*.test.*", "**/*.spec.*"],
    specPatterns: ["docs/**/*.md", "**/spec.md", "**/README.md"],
    layers: [],
    allowedEdges: [],
  },
  experiments: {},
  verification: { commands: [] },
  limits: {
    maxFiles: 500,
    maxFileBytes: 1024 * 1024,
    commandTimeoutMs: 120_000,
    maxOutputBytes: 5 * 1024 * 1024,
    maxFindings: 1_000,
  },
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseReports(
  value: unknown,
  kinds: string[],
  warnings: string[],
  source: string,
  fallback: Array<{ kind: string; path: string }>,
): Array<{ kind: string; path: string }> {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    warnings.push(`${source}: ignored invalid provider report list`);
    return fallback;
  }
  return value.flatMap((item) => {
    const entry = object(item);
    if (!entry || typeof entry.kind !== "string" || !kinds.includes(entry.kind) || typeof entry.path !== "string") {
      warnings.push(`${source}: ignored invalid provider report`);
      return [];
    }
    return [{ kind: entry.kind, path: entry.path }];
  });
}

function stringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : fallback;
}

function parseLayers(
  value: unknown,
  warnings: string[],
  source: string,
  fallback: AiSlopConfig["graph"]["layers"],
): AiSlopConfig["graph"]["layers"] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) {
    warnings.push(`${source}: ignored invalid graph layer list`);
    return fallback;
  }
  return value.flatMap((item) => {
    const entry = object(item);
    if (!entry || typeof entry.name !== "string" || !Array.isArray(entry.patterns) || !entry.patterns.every((part) => typeof part === "string")) {
      warnings.push(`${source}: ignored invalid graph layer`);
      return [];
    }
    return [{ name: entry.name, patterns: entry.patterns as string[] }];
  });
}

function mergeConfig(base: AiSlopConfig, value: unknown, warnings: string[], source: string): AiSlopConfig {
  const input = object(value);
  if (!input) {
    warnings.push(`${source}: configuration must be an object`);
    return base;
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) {
    warnings.push(`${source}: unsupported schemaVersion`);
    return base;
  }
  const network = object(input.network);
  const execution = object(input.execution);
  const limits = object(input.limits);
  const providers = object(input.providers);
  const graph = object(input.graph);
  const lab = object(input.lab);
  const verification = object(input.verification);
  const commands = Array.isArray(verification?.commands)
    ? verification.commands.flatMap((item) => {
        const entry = object(item);
        if (
          !entry ||
          typeof entry.pattern !== "string" ||
          typeof entry.kind !== "string" ||
          !Array.isArray(entry.authoritativeFor) ||
          !entry.authoritativeFor.every((value) => typeof value === "string")
        ) {
          warnings.push(`${source}: ignored invalid verification command`);
          return [];
        }
        const kinds = new Set<VerificationCommandConfig["kind"]>([
          "build",
          "format",
          "lint",
          "typecheck",
          "unit-test",
          "integration-test",
          "security",
          "custom",
        ]);
        if (!kinds.has(entry.kind as VerificationCommandConfig["kind"])) {
          warnings.push(`${source}: ignored verification command with unknown kind`);
          return [];
        }
        return [{
          pattern: entry.pattern,
          kind: entry.kind as VerificationCommandConfig["kind"],
          authoritativeFor: entry.authoritativeFor as string[],
        }];
      })
    : base.verification.commands;
  const lspServers = object(execution?.lspServers);
  const configuredServers = lspServers
    ? Object.fromEntries(
        Object.entries(lspServers).flatMap(([language, command]) =>
          Array.isArray(command) && command.every((part) => typeof part === "string") && command.length
            ? [[language, command as string[]]]
            : [],
        ),
      )
    : base.execution.lspServers;
  const experiments = object(input.experiments);
  return {
    schemaVersion: 1,
    defaultScope: input.defaultScope === "delta" || input.defaultScope === "session" ? input.defaultScope : base.defaultScope,
    network: {
      enabled: typeof network?.enabled === "boolean" ? network.enabled : base.network.enabled,
      registries:
        Array.isArray(network?.registries) && network.registries.every((item) => typeof item === "string")
          ? (network.registries as string[])
          : base.network.registries,
    },
    execution: {
      trusted: typeof execution?.trusted === "boolean" ? execution.trusted : base.execution.trusted,
      commands:
        Array.isArray(execution?.commands) && execution.commands.every((item) => typeof item === "string")
          ? (execution.commands as string[])
          : base.execution.commands,
      lspServers: configuredServers,
    },
    providers: {
      sarif:
        Array.isArray(providers?.sarif) && providers.sarif.every((item) => typeof item === "string")
          ? (providers.sarif as string[])
          : base.providers.sarif,
      analyzerReports: parseReports(
        providers?.analyzerReports,
        ["eslint", "ruff", "pyright", "knip"],
        warnings,
        source,
        base.providers.analyzerReports,
      ) as AiSlopConfig["providers"]["analyzerReports"],
      coverageReports: parseReports(
        providers?.coverageReports,
        ["lcov", "coverage-py-json"],
        warnings,
        source,
        base.providers.coverageReports,
      ) as AiSlopConfig["providers"]["coverageReports"],
    },
    lab: {
      enabled: typeof lab?.enabled === "boolean" ? lab.enabled : base.lab.enabled,
      criticalPatterns: stringArray(lab?.criticalPatterns, base.lab.criticalPatterns),
      maxPatchBytes: positiveInteger(lab?.maxPatchBytes, base.lab.maxPatchBytes),
      maxCommands: positiveInteger(lab?.maxCommands, base.lab.maxCommands),
    },
    graph: {
      enabled: typeof graph?.enabled === "boolean" ? graph.enabled : base.graph.enabled,
      testPatterns: stringArray(graph?.testPatterns, base.graph.testPatterns),
      specPatterns: stringArray(graph?.specPatterns, base.graph.specPatterns),
      layers: parseLayers(graph?.layers, warnings, source, base.graph.layers),
      allowedEdges: stringArray(graph?.allowedEdges, base.graph.allowedEdges),
    },
    experiments: experiments
      ? Object.fromEntries(Object.entries(experiments).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
      : base.experiments,
    verification: { commands },
    limits: {
      maxFiles: positiveInteger(limits?.maxFiles, base.limits.maxFiles),
      maxFileBytes: positiveInteger(limits?.maxFileBytes, base.limits.maxFileBytes),
      commandTimeoutMs: positiveInteger(limits?.commandTimeoutMs, base.limits.commandTimeoutMs),
      maxOutputBytes: positiveInteger(limits?.maxOutputBytes, base.limits.maxOutputBytes),
      maxFindings: positiveInteger(limits?.maxFindings, base.limits.maxFindings),
    },
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function readConfigFile(filePath: string, config: AiSlopConfig, warnings: string[]): AiSlopConfig {
  if (!existsSync(filePath)) return config;
  try {
    return mergeConfig(config, JSON.parse(readFileSync(filePath, "utf8")), warnings, filePath);
  } catch (error) {
    warnings.push(`${filePath}: ${(error as Error).message}`);
    return config;
  }
}

export function loadConfig(
  rootDir: string,
  options: { trustProjectConfig?: boolean; globalPath?: string } = {},
): LoadedConfig {
  const warnings: string[] = [];
  const sources: string[] = [];
  const globalPath = options.globalPath ?? process.env.PI_AI_SLOP_CONFIG ?? path.join(homedir(), ".pi", "agent", "ai-slop", "config.json");
  let config = DEFAULT_CONFIG;
  if (existsSync(globalPath)) {
    config = readConfigFile(globalPath, config, warnings);
    sources.push(globalPath);
  }
  const projectPath = path.join(path.resolve(rootDir), ".pi", "ai-slop.json");
  if (options.trustProjectConfig && existsSync(projectPath)) {
    config = readConfigFile(projectPath, config, warnings);
    sources.push(projectPath);
  } else if (existsSync(projectPath)) {
    warnings.push(`${projectPath}: ignored until project configuration is explicitly trusted`);
  }
  return { config, hash: sha256(canonicalJson(config)), sources, warnings };
}
