import { DEFAULT_CONFIG, type AiSlopConfig } from "../core/config.ts";
import { canonicalJson, fingerprint, mergeScanResults, sha256 } from "../core/schema.ts";
import { collectGraphEvidence } from "../graph/provider.ts";
import { applyPolicy } from "../policy/engine.ts";
import type { ScanResult, ScanScope } from "../types.ts";
import { importAnalyzerReports } from "./analyzer-reports.ts";
import { importCoverageReports } from "./coverage.ts";
import { collectDependencyProvenance } from "./dependencies.ts";
import { collectLspEvidence } from "./lsp.ts";
import { runProvider, type EvidenceProvider, type ProviderContext } from "./provider.ts";
import { importSarif } from "./sarif.ts";

export interface FederationOptions {
  config?: AiSlopConfig;
  configHash?: string;
  trustedProject?: boolean;
  graphStateRoot?: string;
  policyStateRoot?: string;
}

export async function federateEvidence(
  rootDir: string,
  paths: string[],
  nativeResults: ScanResult[],
  mode: ScanScope["mode"],
  options: FederationOptions = {},
  signal?: AbortSignal,
): Promise<ScanResult> {
  const config = options.config ?? DEFAULT_CONFIG;
  const results = [...nativeResults];
  const seed = mergeScanResults(rootDir, nativeResults, mode);

  const context: ProviderContext = {
    rootDir,
    paths,
    scope: mode,
    config,
    configHash: options.configHash ?? sha256(canonicalJson(config)),
    trustedProject: Boolean(options.trustedProject),
  };
  const reportProviders: EvidenceProvider[] = [
    {
      id: "sarif",
      version: "2.1.0",
      capabilities: ["diagnostics", "control-flow", "data-flow"],
      supports: () => config.providers.sarif.length > 0,
      collect: async () => ({ run: { id: "sarif", version: "2.1.0", capabilities: ["diagnostics"], status: "completed" }, result: importSarif(rootDir, config.providers.sarif) }),
    },
    {
      id: "analyzer-reports",
      version: "1",
      capabilities: ["diagnostics", "types", "references", "dependencies"],
      supports: () => config.providers.analyzerReports.length > 0,
      collect: async () => ({ run: { id: "analyzer-reports", version: "1", capabilities: ["diagnostics"], status: "completed" }, result: importAnalyzerReports(rootDir, config.providers.analyzerReports) }),
    },
    {
      id: "coverage-reports",
      version: "1",
      capabilities: ["coverage"],
      supports: () => config.providers.coverageReports.length > 0,
      collect: async () => ({ run: { id: "coverage-reports", version: "1", capabilities: ["coverage"], status: "completed" }, result: importCoverageReports(rootDir, config.providers.coverageReports) }),
    },
  ];
  for (const provider of reportProviders) {
    const output = await runProvider(provider, context, signal);
    if (output.result) {
      output.result.providers = [output.run];
      results.push(output.result);
    }
  }
  results.push(...(await collectLspEvidence(rootDir, paths, config, Boolean(options.trustedProject), signal)));
  results.push(await collectGraphEvidence(rootDir, paths, config, signal, options.graphStateRoot, mode));
  if (seed.findings.some((finding) => finding.ruleId === "dependency.unresolved")) {
    results.push(await collectDependencyProvenance(rootDir, seed, config, signal));
  }

  const merged = mergeScanResults(rootDir, results, mode);
  merged.engine = "provider-federation";
  merged.engineVersion = `federation 1; ${merged.engineVersion}`;
  merged.scope.contentHash = sha256(
    canonicalJson({ contentHash: merged.scope.contentHash, configHash: options.configHash ?? sha256(canonicalJson(config)) }),
  );
  merged.scanId = fingerprint("scan", {
    contentHash: merged.scope.contentHash,
    findings: merged.findings.map((finding) => finding.id),
    providers: merged.providers,
  });
  return applyPolicy(rootDir, merged, config, options.policyStateRoot);
}
