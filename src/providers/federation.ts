import { assessScanCompleteness } from "../core/completeness.ts";
import { resourceBudgetDiagnostic, type ResourceBudget } from "../core/budget.ts";
import { DEFAULT_CONFIG, type AiSlopConfig } from "../core/config.ts";
import { canonicalJson, createScanResult, fingerprint, mergeScanResults, sha256 } from "../core/schema.ts";
import { rankFindings } from "../core/severity.ts";
import { collectGraphEvidence } from "../graph/provider.ts";
import { applyPolicy } from "../policy/engine.ts";
import type { ScanResult, ScanScope } from "../types.ts";
import type { TypeScriptProjectContext } from "../typescript-scanner.ts";
import { importAnalyzerReports } from "./analyzer-reports.ts";
import { importCoverageReports } from "./coverage.ts";
import { collectDependencyProvenance } from "./dependencies.ts";
import { collectLspEvidence } from "./lsp.ts";
import { runProvider, type EvidenceProvider, type ProviderContext } from "./provider.ts";
import { importSarif } from "./sarif.ts";
function boundResult(result: ScanResult, config: AiSlopConfig): void {
  const maxEvidence = Math.min(5_000, Math.max(100, config.limits.maxFindings * 4));
  const referenced = new Set(result.findings.flatMap((finding) => [...finding.evidenceIds, ...finding.counterEvidenceIds]));
  const evidenceById = new Map(result.evidenceRecords.map((record) => [record.id, record]));
  const orderedEvidence = [
    ...[...referenced].flatMap((id) => evidenceById.get(id) ?? []),
    ...result.evidenceRecords.filter((record) => !referenced.has(record.id)),
  ];
  const omittedEvidence = Math.max(0, orderedEvidence.length - maxEvidence);
  result.evidenceRecords = orderedEvidence.slice(0, maxEvidence);
  result.providers = result.providers.slice(0, 100);
  result.policyDecisions = result.policyDecisions.slice(0, config.limits.maxFindings);
  result.ruleHealth = result.ruleHealth.slice(0, 1_000);
  result.suppressedFindings = result.suppressedFindings.slice(0, config.limits.maxFindings);
  result.skipped = result.skipped.slice(0, config.limits.maxFiles + 100);
  if (omittedEvidence) result.skipped.push({
    filePath: "<evidence>",
    reason: `${omittedEvidence} evidence record(s) omitted after the bounded evidence limit of ${maxEvidence}`,
    providerId: "provider-federation",
  });

  let outputBytes = Buffer.byteLength(JSON.stringify(result));
  let reduced = false;
  for (let attempt = 0; outputBytes > config.limits.maxOutputBytes && attempt < 12; attempt += 1) {
    reduced = true;
    if (result.evidenceRecords.length) result.evidenceRecords.length = Math.floor(result.evidenceRecords.length / 2);
    else if (result.findings.length) result.findings.length = Math.floor(result.findings.length / 2);
    else if (result.skipped.length > 1) result.skipped.length = Math.max(1, Math.floor(result.skipped.length / 2));
    else break;
    outputBytes = Buffer.byteLength(JSON.stringify(result));
  }
  if (reduced) {
    const findingIds = new Set(result.findings.map((finding) => finding.id));
    result.policyDecisions = result.policyDecisions.filter((decision) => findingIds.has(decision.findingId));
    result.skipped.push({
      filePath: "<output>",
      reason: `scan output reduced to stay within the configured ${config.limits.maxOutputBytes} byte limit`,
      providerId: "provider-federation",
    });
    for (let attempt = 0; Buffer.byteLength(JSON.stringify(result)) > config.limits.maxOutputBytes && attempt < 12; attempt += 1) {
      if (result.evidenceRecords.length) result.evidenceRecords.length = Math.floor(result.evidenceRecords.length / 2);
      else if (result.findings.length) result.findings.length = Math.floor(result.findings.length / 2);
      else if (result.skipped.length > 1) result.skipped = result.skipped.slice(-Math.max(1, Math.floor(result.skipped.length / 2)));
      else break;
    }
    const retainedFindingIds = new Set(result.findings.map((finding) => finding.id));
    result.policyDecisions = result.policyDecisions.filter((decision) => retainedFindingIds.has(decision.findingId));
  }
}


export interface FederationOptions {
  config?: AiSlopConfig;
  configHash?: string;
  trustedProject?: boolean;
  graphStateRoot?: string;
  policyStateRoot?: string;
  typescriptProjects?: TypeScriptProjectContext[];
  graphSkipReason?: string;
  memoryBudgetBytes?: number;
  budget?: ResourceBudget;
  budgetReason?: string;
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
      collect: async () => ({ run: { id: "analyzer-reports", version: "1", capabilities: ["diagnostics"], status: "completed" }, result: importAnalyzerReports(rootDir, config.providers.analyzerReports, config.limits.maxFindings) }),
    },
    {
      id: "coverage-reports",
      version: "1",
      capabilities: ["coverage"],
      supports: () => config.providers.coverageReports.length > 0,
      collect: async () => ({ run: { id: "coverage-reports", version: "1", capabilities: ["coverage"], status: "completed" }, result: importCoverageReports(rootDir, config.providers.coverageReports) }),
    },
  ];
  let budgetReason = options.budgetReason ?? resourceBudgetDiagnostic(options.budget);
  for (let index = 0; index < reportProviders.length && !budgetReason; index += 2) {
    const batch = await Promise.all(reportProviders.slice(index, index + 2).map(async (provider) => ({
      provider,
      output: await runProvider(provider, context, signal),
    })));
    for (const { provider, output } of batch) {
      if (output.result) {
        output.result.providers = [output.run];
        results.push(output.result);
      } else if (output.run.status === "failed") {
        results.push(createScanResult({
          engine: "provider-federation",
          engineVersion: `${provider.id} failed`,
          rootDir,
          providerId: provider.id,
          providerVersion: provider.version,
          providers: [output.run],
          scannedFiles: [],
          findings: [],
          skipped: [{ filePath: `<${provider.id}>`, reason: output.run.diagnostic ?? "provider failed", providerId: provider.id }],
        }));
      }
    }
    budgetReason = resourceBudgetDiagnostic(options.budget);
  }
  if (!budgetReason) {
    results.push(...(await collectLspEvidence(rootDir, paths, config, Boolean(options.trustedProject), signal)));
    budgetReason = resourceBudgetDiagnostic(options.budget);
  }
  if (!budgetReason) {
    results.push(await collectGraphEvidence(rootDir, paths, config, signal, options.graphStateRoot, mode, options.typescriptProjects, options.graphSkipReason));
    budgetReason = resourceBudgetDiagnostic(options.budget);
  }
  if (!budgetReason && seed.findings.some((finding) => finding.ruleId === "dependency.unresolved")) {
    results.push(await collectDependencyProvenance(rootDir, seed, config, signal));
    budgetReason = resourceBudgetDiagnostic(options.budget);
  }
  if (budgetReason) {
    results.push(createScanResult({
      engine: "provider-federation",
      engineVersion: "resource budget exhausted",
      rootDir,
      providerId: "resource-budget",
      providerVersion: "1",
      providers: [{ id: "resource-budget", version: "1", capabilities: [], status: "skipped", diagnostic: budgetReason }],
      scannedFiles: [],
      findings: [],
      skipped: [{ filePath: "<resource-budget>", reason: budgetReason, providerId: "resource-budget" }],
    }));
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
  const reviewed = applyPolicy(rootDir, merged, config, options.policyStateRoot);
  if (reviewed.findings.length > config.limits.maxFindings) {
    const total = reviewed.findings.length;
    reviewed.findings = rankFindings(reviewed.findings, reviewed.policyDecisions)
      .slice(0, config.limits.maxFindings)
      .map((item) => item.finding);
    reviewed.skipped.push({
      filePath: "<findings>",
      reason: `${total - reviewed.findings.length} finding(s) omitted after the weighted-priority limit of ${config.limits.maxFindings}`,
      providerId: "provider-federation",
    });
    reviewed.scanId = fingerprint("scan", {
      inputScanId: reviewed.scanId,
      findingLimit: config.limits.maxFindings,
      findings: reviewed.findings.map((finding) => finding.id),
    });
  }
  boundResult(reviewed, config);
  reviewed.completeness = assessScanCompleteness(reviewed);
  reviewed.scanId = fingerprint("scan", {
    inputScanId: reviewed.scanId,
    completeness: reviewed.completeness,
    skipped: reviewed.skipped,
  });
  return reviewed;
}
