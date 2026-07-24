import type { ProviderRun, ScanCompleteness, SkippedFile } from "../types.ts";

interface CompletenessInput {
  scannedFiles: string[];
  providers: ProviderRun[];
  skipped: SkippedFile[];
}

function intentionallyDisabled(item: SkippedFile): boolean {
  return /^<[^>]+>$/.test(item.filePath) && /disabled by configuration/i.test(item.reason);
}

export function assessScanCompleteness(input: CompletenessInput): ScanCompleteness {
  const blockingSkips = input.skipped.filter((item) => !intentionallyDisabled(item));
  const incompleteProviders = input.providers.filter((provider) => provider.status === "degraded" || provider.status === "failed");
  const reasons = [
    ...(input.scannedFiles.length ? [] : ["no files were scanned"]),
    ...incompleteProviders.map((provider) => `${provider.id} ${provider.status}${provider.diagnostic ? `: ${provider.diagnostic}` : ""}`),
    ...(blockingSkips.length ? [`${blockingSkips.length} scan item(s) skipped or omitted`] : []),
  ];
  return {
    status: input.scannedFiles.length === 0 ? "abstained" : reasons.length ? "partial" : "complete",
    scannedFiles: input.scannedFiles.length,
    skippedItems: blockingSkips.length,
    reasons,
  };
}
