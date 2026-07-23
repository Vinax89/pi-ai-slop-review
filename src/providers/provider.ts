import type { AiSlopConfig } from "../core/config.ts";
import type { EvidenceRecord, ProviderCapability, ProviderRun, ScanResult, ScanScope, SkippedFile } from "../types.ts";

export interface ProviderContext {
  rootDir: string;
  paths: string[];
  scope: ScanScope["mode"];
  config: AiSlopConfig;
  configHash: string;
  trustedProject: boolean;
}

export interface ProviderOutput {
  run: ProviderRun;
  result?: ScanResult;
  evidence?: EvidenceRecord[];
  skipped?: SkippedFile[];
}

export interface EvidenceProvider {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly ProviderCapability[];
  supports(context: ProviderContext): boolean;
  collect(context: ProviderContext, signal?: AbortSignal): Promise<ProviderOutput>;
}

export async function runProvider(
  provider: EvidenceProvider,
  context: ProviderContext,
  signal?: AbortSignal,
): Promise<ProviderOutput> {
  if (!provider.supports(context)) {
    return {
      run: {
        id: provider.id,
        version: provider.version,
        capabilities: [...provider.capabilities],
        status: "skipped",
        diagnostic: "provider does not support this scope",
      },
    };
  }
  const started = performance.now();
  try {
    const output = await provider.collect(context, signal);
    return {
      ...output,
      run: {
        ...output.run,
        id: provider.id,
        version: provider.version,
        capabilities: [...provider.capabilities],
        durationMs: Math.round(performance.now() - started),
      },
    };
  } catch (error) {
    return {
      run: {
        id: provider.id,
        version: provider.version,
        capabilities: [...provider.capabilities],
        status: signal?.aborted ? "skipped" : "failed",
        durationMs: Math.round(performance.now() - started),
        diagnostic: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
