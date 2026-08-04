import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Text as PiText } from "@earendil-works/pi-tui";
import type { Type as TypeboxType } from "typebox";

import { assessScanCompleteness } from "./src/core/completeness.ts";
import { loadConfig, redactConfig, type LoadedConfig } from "./src/core/config.ts";
import { discoverRepositoryFiles } from "./src/core/discovery.ts";
import { splitCommand as splitCommandPaths } from "./src/core/execution.ts";
import { rankFindings, weightedSeverity } from "./src/core/severity.ts";
import { AssuranceLedger, diffScans, type ScanDelta, type VerificationStatus } from "./src/core/ledger.ts";
import { StateStore } from "./src/core/store.ts";
import { diagnose, formatDiagnostics } from "./src/diagnostics.ts";
import { fingerprint } from "./src/core/schema.ts";
import { runIndependentCritics } from "./src/experiments/critics.ts";
import { runExpressionExperiment } from "./src/experiments/expression.ts";
import { runSmtEquivalence, runTranslationValidation } from "./src/experiments/formal.ts";
import { retrieveRepositoryContext } from "./src/experiments/retrieval.ts";
import { writeExport } from "./src/export.ts";
import { queryContext } from "./src/graph/query.ts";
import { applyProposal, createProposal, listLaboratory, rollbackProposal, validateProposal } from "./src/lab.ts";
import { addSuppression, recordFeedback, removeSuppression } from "./src/policy/engine.ts";
import { formatClaims, formatDelta, formatReport, formatTimeline } from "./src/report.ts";
import { scanFiles } from "./src/scan.ts";
import type { ClaimAssessment, ExperimentSpec, FeedbackRecord, Finding, LedgerEvent, ScanResult, ScanScope } from "./src/types.ts";

const DISABLED = existsSync(fileURLToPath(new URL(".disabled", import.meta.url)));
const ENTRY_TYPE = "ai-slop-review";
const LEDGER_ENTRY_TYPE = "ai-slop-ledger-v1";
const LEGACY_TOUCHED_ENTRY_TYPE = "ai-slop-touched";
const REVIEW_BASELINE_NAME = "last-review";
const AUDIT_BASELINE_NAME = "last-audit";
type RuntimeText = typeof PiText;
type RuntimeType = typeof TypeboxType;

function optionalPeerError(name: string, error: unknown): Error {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  return new Error(`AI-slop review requires optional peer '${name}' to initialize Pi integration${detail}`, { cause: error });
}

async function loadRuntimePeers(): Promise<{ Text: RuntimeText; Type: RuntimeType }> {
  let tui: { Text: RuntimeText };
  try {
    // Pi host peers are optional; defer resolution until the integration is initialized.
    tui = await import("@earendil-works/pi-tui");
  } catch (error) {
    throw optionalPeerError("@earendil-works/pi-tui", error);
  }
  let typebox: { Type: RuntimeType };
  try {
    typebox = await import("typebox");
  } catch (error) {
    throw optionalPeerError("typebox", error);
  }
  return { Text: tui.Text, Type: typebox.Type };
}

interface ReviewOutcome {
  result: ScanResult;
  delta: ScanDelta;
  verification: VerificationStatus[];
  claims: ClaimAssessment[];
  warnings: string[];
  reportPath?: string;
}

function resultSummary(outcome: ReviewOutcome): string {
  const completeness = outcome.result.completeness ?? assessScanCompleteness(outcome.result);
  return `${completeness.status}: ${outcome.result.findings.length} finding(s), ${outcome.result.scannedFiles.length} scanned, ${outcome.result.skipped.length} skipped; ${outcome.delta.added.length} new`;
}

function reviewText(outcome: ReviewOutcome, maxFindings: number): string {
  const sections = [formatReport(outcome.result, maxFindings), formatDelta(outcome.delta)];
  if (outcome.verification.length) sections.push(formatTimeline([], outcome.verification));
  if (outcome.claims.length) sections.push(formatClaims(outcome.claims));
  if (outcome.reportPath) sections.push(`Markdown report: ${outcome.reportPath}`);
  if (outcome.warnings.length) sections.push(`Warnings:\n${outcome.warnings.map((item) => `  ${item}`).join("\n")}`);
  return sections.join("\n\n");
}

export default async function (pi: any): Promise<void> {
  if (DISABLED) return;
  const { Text, Type } = await loadRuntimePeers();
  let ledger: AssuranceLedger | undefined;
  let loadedConfig: LoadedConfig | undefined;
  let store: StateStore | undefined;
  let trustedProject = false;
  let legacyTouchedPaths = new Set<string>();
  let lastOutcome: ReviewOutcome | undefined;

  const initialize = (ctx: any): void => {
    trustedProject = Boolean(ctx.isProjectTrusted?.());
    loadedConfig = loadConfig(ctx.cwd, { trustProjectConfig: trustedProject });
    ledger = new AssuranceLedger(ctx.cwd, loadedConfig.config);
    const events: LedgerEvent[] = [];
    legacyTouchedPaths = new Set<string>();
    lastOutcome = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === LEDGER_ENTRY_TYPE && entry.data?.schemaVersion === 1) events.push(entry.data as LedgerEvent);
      if (entry.customType === LEGACY_TOUCHED_ENTRY_TYPE && typeof entry.data?.path === "string") {
        legacyTouchedPaths.add(entry.data.path);
      }
      if (entry.customType === ENTRY_TYPE && entry.data?.result?.schemaVersion === 1) lastOutcome = entry.data as ReviewOutcome;
    }
    ledger.reconstruct(events);
    store = new StateStore(ctx.cwd);
    if (!lastOutcome) {
      try {
        const persisted = store.load().baselines[REVIEW_BASELINE_NAME] ?? store.load().baselines[AUDIT_BASELINE_NAME];
        if (persisted) {
          lastOutcome = {
            result: persisted,
            delta: diffScans(persisted),
            verification: ledger.verificationStatus(persisted.scope.paths),
            claims: [],
            warnings: ["latest review restored from persistent state"],
          };
        }
      } catch {
        // A corrupt baseline is reported by state-backed commands when they access it.
      }
    }
  };

  const ensureInitialized = (ctx: any): AssuranceLedger => {
    if (!ledger || !loadedConfig || !store) initialize(ctx);
    return ledger as AssuranceLedger;
  };

  const trackedPaths = (): string[] => [...new Set([...(ledger?.touchedPaths() ?? []), ...legacyTouchedPaths])].sort();

  const findingByPrefix = (prefix: string): Finding => {
    const matches = lastOutcome?.result.findings.filter((finding) => finding.id === prefix || finding.id.startsWith(prefix)) ?? [];
    if (matches.length !== 1) throw new Error(matches.length ? `finding prefix '${prefix}' is ambiguous` : `finding '${prefix}' was not found in the latest review`);
    return matches[0];
  };

  const findingDetails = (finding: Finding): string => {
    const decision = lastOutcome?.result.policyDecisions.find((item) => item.findingId === finding.id);
    const severity = weightedSeverity(finding, decision);
    const providers = lastOutcome?.result.evidenceRecords
      .filter((item) => finding.evidenceIds.includes(item.id) || item.source?.filePath === finding.filePath && item.source.end >= finding.start && item.source.start <= finding.end)
      .map((item) => item.providerId) ?? [];
    return [
      `${finding.confidence} ${finding.ruleId} ${finding.filePath}:${finding.line}:${finding.column}`,
      finding.message,
      `ID: ${finding.id}`,
      `Weighted severity: ${severity.severity} (${severity.score}/100)`,
      `Classification: ${finding.classification}; risk: ${finding.risk}; maximum action: ${finding.maximumAction}`,
      `Providers: ${[...new Set(providers)].join(", ") || "detector only"}`,
      ...finding.evidence.map((item) => `Evidence: ${item}`),
      ...finding.counterEvidence.map((item) => `Counterevidence: ${item}`),
      ...finding.unknown.map((item) => `Unknown: ${item}`),
      ...(decision ? [`Policy score: ${decision.evidenceScore.toFixed(2)}`, ...decision.reasons.map((item) => `Policy: ${item}`)] : []),
    ].join("\n");
  };

  const review = async (
    cwd: string,
    requestedPaths: string[] | undefined,
    signal: AbortSignal | undefined,
    claimsText = "",
    mode: ScanScope["mode"] = requestedPaths?.length ? "explicit" : "session",
    discoveryTruncated = false,
  ): Promise<ReviewOutcome> => {
    if (!ledger || !loadedConfig || !store) throw new Error("AI-slop review is not initialized");
    const explicit = Boolean(requestedPaths?.length);
    const paths = explicit ? requestedPaths! : trackedPaths();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await scanFiles(cwd, paths, signal, mode, {
      config: loadedConfig.config,
      configHash: loadedConfig.hash,
      trustedProject,
    });
    if (signal?.aborted || result.completeness?.status === "abstained") throw new Error("AI-slop review cancelled");
    if (discoveryTruncated) {
      result.skipped.push({
        filePath: "<repository-discovery>",
        reason: `repository discovery stopped at ${loadedConfig!.config.limits.maxFiles} files`,
        providerId: "repository-discovery",
      });
      result.completeness = assessScanCompleteness(result);
      result.scanId = fingerprint("scan", {
        contentHash: result.scope.contentHash,
        findings: result.findings.map((finding) => finding.id),
        providers: result.providers,
        skipped: result.skipped,
        completeness: result.completeness,
      });
    }
    let baseline: ScanResult | undefined;
    const warnings = [...loadedConfig.warnings];
    try {
      const baselineName = mode === "repository" ? AUDIT_BASELINE_NAME : REVIEW_BASELINE_NAME;
      baseline = store.load().baselines[baselineName];
      store.update((state) => {
        state.baselines[baselineName] = result;
      });
    } catch (error) {
      warnings.push(`state store: ${(error as Error).message}`);
    }
    let reportPath: string | undefined;
    try {
      reportPath = writeExport(cwd, result, "markdown");
    } catch (error) {
      warnings.push(`markdown report: ${(error as Error).message}`);
    }
    return {
      result,
      delta: diffScans(result, baseline),
      verification: ledger.verificationStatus(paths),
      claims: claimsText ? ledger.assessClaims(claimsText) : [],
      warnings,
      reportPath,
    };
  };

  pi.on("session_start", (_event: unknown, ctx: any) => initialize(ctx));
  pi.on("session_tree", (_event: unknown, ctx: any) => initialize(ctx));

  pi.on("tool_call", (event: unknown, ctx: any) => {
    ensureInitialized(ctx).captureToolCall(event as any);
  });

  pi.on("tool_result", (event: unknown, ctx: any) => {
    const captured = ensureInitialized(ctx).captureToolResult(event as any);
    if (captured) pi.appendEntry(LEDGER_ENTRY_TYPE, captured);
  });

  pi.registerEntryRenderer(ENTRY_TYPE, (entry: any, { expanded }: { expanded: boolean }, theme: any) => {
    const outcome = entry.data as ReviewOutcome;
    if (!outcome?.result) {
      const legacy = entry.data as Partial<ScanResult>;
      const summary = `${legacy.findings?.length ?? 0} finding(s), ${legacy.scannedFiles?.length ?? 0} scanned (legacy entry)`;
      return new Text(theme.fg("dim", summary), 0, 0);
    }
    let text = theme.fg("toolTitle", theme.bold("AI-slop review "));
    text += theme.fg(outcome.result.findings.length ? "warning" : "success", resultSummary(outcome));
    if (expanded) text += `\n${theme.fg("dim", reviewText(outcome, 20))}`;
    return new Text(text, 0, 0);
  });

  pi.registerCommand("slop-review", {
    description: "Read-only evidence review of current-session changes; optional project-relative paths separated by spaces",
    handler: async (args: string, ctx: any) => {
      ensureInitialized(ctx);
      const paths = splitCommandPaths(args);
      if (!paths.length && !trackedPaths().length) {
        ctx.ui.notify("No current-session supported file changes are tracked; pass explicit paths", "warning");
        return;
      }
      ctx.ui.setStatus("ai-slop", `reviewing ${paths.length || trackedPaths().length} file(s)…`);
      ctx.ui.notify("AI-slop review started…", "info");
      try {
        const outcome = await review(ctx.cwd, paths.length ? paths : undefined, ctx.signal);
        lastOutcome = outcome;
        pi.appendEntry(ENTRY_TYPE, outcome);
        ctx.ui.setStatus("ai-slop", `${outcome.result.findings.length} findings · ${outcome.delta.added.length} new`);
        ctx.ui.notify(`AI-slop review: ${resultSummary(outcome)}${outcome.reportPath ? `\nMarkdown: ${outcome.reportPath}` : ""}`, outcome.result.findings.length ? "warning" : "info");
      } catch (error) {
        ctx.ui.setStatus("ai-slop", "review failed");
        ctx.ui.notify(`AI-slop review failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("slop-audit", {
    description: "Explicit repository-wide read-only audit of supported source, specification, and manifest files",
    handler: async (_args: string, ctx: any) => {
      ensureInitialized(ctx);
      const discovery = discoverRepositoryFiles(ctx.cwd, loadedConfig!.config.limits.maxFiles);
      if (!discovery.paths.length) {
        ctx.ui.notify("No supported repository files were found", "warning");
        return;
      }
      ctx.ui.setStatus("ai-slop", `auditing ${discovery.paths.length} file(s)…`);
      ctx.ui.notify(`Auditing ${discovery.paths.length} file(s)${discovery.truncated ? " (configured limit reached)" : ""}...`, "info");
      try {
        const outcome = await review(ctx.cwd, discovery.paths, ctx.signal, "", "repository", discovery.truncated);
        if (discovery.truncated) outcome.warnings.push(`repository discovery stopped at ${loadedConfig!.config.limits.maxFiles} files; result completeness is partial`);
        lastOutcome = outcome;
        pi.appendEntry(ENTRY_TYPE, outcome);
        ctx.ui.setStatus("ai-slop", `${outcome.result.findings.length} audit findings · ${outcome.delta.added.length} new`);
        ctx.ui.notify(`AI-slop audit: ${resultSummary(outcome)}${outcome.reportPath ? `\nMarkdown: ${outcome.reportPath}` : ""}`, outcome.result.findings.length ? "warning" : "info");
      } catch (error) {
        ctx.ui.setStatus("ai-slop", "audit failed");
        ctx.ui.notify(`AI-slop audit failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("slop-findings", {
    description: "Browse or inspect findings from the latest review",
    handler: async (args: string, ctx: any) => {
      ensureInitialized(ctx);
      if (!lastOutcome?.result.findings.length) {
        ctx.ui.notify("No findings are available from the latest review", "info");
        return;
      }
      let finding: Finding;
      try {
        if (args.trim()) finding = findingByPrefix(args.trim());
        else {
          const options = rankFindings(lastOutcome.result.findings, lastOutcome.result.policyDecisions)
            .slice(0, 200)
            .map((item) => `${item.finding.id.slice(-8)}  ${item.severity.toUpperCase()} ${item.score}/100  ${item.finding.ruleId}  ${item.finding.filePath}:${item.finding.line}`);
          const selected = await ctx.ui.select("AI-slop findings", options);
          if (!selected) return;
          const suffix = selected.split(/\s+/)[0];
          const matches = lastOutcome.result.findings.filter((item) => item.id.endsWith(suffix));
          if (matches.length !== 1) throw new Error("selected finding is no longer unique");
          finding = matches[0];
        }
        ctx.ui.notify(findingDetails(finding), finding.risk === "R3" ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  pi.registerCommand("slop-suppress", {
    description: "Suppress a latest-review finding with a required reason; use --durable or --until=ISO",
    handler: async (args: string, ctx: any) => {
      ensureInitialized(ctx);
      const tokens = splitCommandPaths(args);
      const prefix = tokens.shift();
      if (!prefix) {
        ctx.ui.notify("Usage: /slop-suppress <finding-id-prefix> [--durable] [--until=ISO] <reason>", "warning");
        return;
      }
      try {
        const finding = findingByPrefix(prefix);
        const durable = tokens.includes("--durable");
        const expiry = tokens.find((token) => token.startsWith("--until="))?.slice("--until=".length);
        const reason = tokens.filter((token) => token !== "--durable" && !token.startsWith("--until=")).join(" ").trim();
        if (!reason) throw new Error("a suppression reason is required");
        const confirmed = await ctx.ui.confirm("Suppress finding?", `${finding.ruleId} at ${finding.filePath}:${finding.line}\nReason: ${reason}`);
        if (!confirmed) return;
        const suppression = addSuppression(ctx.cwd, {
          ruleId: finding.ruleId,
          filePath: finding.filePath,
          anchor: finding.anchor,
          sourceHash: durable ? undefined : finding.sourceHash,
          reason,
          expiresAt: expiry,
        });
        ctx.ui.notify(`Suppression recorded: ${suppression.id}`, "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  pi.registerCommand("slop-unsuppress", {
    description: "Remove a suppression by exact ID",
    handler: async (args: string, ctx: any) => {
      ensureInitialized(ctx);
      const id = args.trim();
      if (!id) {
        ctx.ui.notify("Usage: /slop-unsuppress <suppression-id>", "warning");
        return;
      }
      ctx.ui.notify(removeSuppression(ctx.cwd, id) ? `Removed ${id}` : `Suppression ${id} was not found`, "info");
    },
  });

  pi.registerCommand("slop-feedback", {
    description: "Record reasoned local feedback for a latest-review finding",
    handler: async (args: string, ctx: any) => {
      ensureInitialized(ctx);
      const tokens = splitCommandPaths(args);
      const prefix = tokens.shift();
      const outcome = tokens.shift() as FeedbackRecord["outcome"] | undefined;
      const valid = new Set<FeedbackRecord["outcome"]>([
        "accepted", "intentional", "wrong-location", "missing-context", "duplicate", "unsafe-proposal", "insufficient-evidence", "local-convention",
      ]);
      const reason = tokens.join(" ").trim();
      if (!prefix || !outcome || !valid.has(outcome) || !reason) {
        ctx.ui.notify("Usage: /slop-feedback <finding-id-prefix> <outcome> <reason>", "warning");
        return;
      }
      try {
        const finding = findingByPrefix(prefix);
        const providers = lastOutcome!.result.evidenceRecords
          .filter((item) => finding.evidenceIds.includes(item.id) || item.source?.filePath === finding.filePath)
          .map((item) => item.providerId);
        const feedback = recordFeedback(ctx.cwd, finding, outcome, reason, providers, outcome === "unsafe-proposal");
        ctx.ui.notify(`Local feedback recorded: ${feedback.id}`, "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  pi.registerCommand("slop-rules", {
    description: "Show policy decisions and local rule-health calibration",
    handler: async (_args: string, ctx: any) => {
      ensureInitialized(ctx);
      if (!lastOutcome) {
        ctx.ui.notify("Run /slop-review or /slop-audit first", "warning");
        return;
      }
      const health = lastOutcome.result.ruleHealth.length
        ? lastOutcome.result.ruleHealth.map((item) => `${item.status} ${item.ruleId}: ${item.accepted}/${item.samples} accepted, threshold ${item.selectiveThreshold?.toFixed(2) ?? "unavailable"}`)
        : ["No local feedback calibration is available; static conservative policy remains active."];
      const decisions = lastOutcome.result.policyDecisions.filter((item) => item.reasons.length).slice(0, 50).map((item) => `${item.findingId.slice(-8)}: ${item.originalAction} → ${item.finalAction}; ${item.reasons.join("; ")}`);
      ctx.ui.notify([...health, ...decisions].join("\n"), "info");
    },
  });

  pi.registerCommand("slop-context", {
    description: "Query repository graph context and impact by exact symbol name or project-relative path",
    handler: async (args: string, ctx: any) => {
      ensureInitialized(ctx);
      if (!args.trim()) {
        ctx.ui.notify("Usage: /slop-context <symbol-or-path>", "warning");
        return;
      }
      const context = queryContext(ctx.cwd, args.trim());
      ctx.ui.notify(JSON.stringify(context, null, 2), context.nodes.length ? "info" : "warning");
    },
  });

  pi.registerCommand("slop-export", {
    description: "Export the latest review as Markdown, JSON, or SARIF; optional explicit project-relative output path",
    handler: async (args: string, ctx: any) => {
      ensureInitialized(ctx);
      if (!lastOutcome) {
        ctx.ui.notify("Run /slop-review or /slop-audit first", "warning");
        return;
      }
      const [requestedFormat = "json", outputPath] = splitCommandPaths(args);
      const format = requestedFormat === "md" ? "markdown" : requestedFormat;
      if (format !== "json" && format !== "sarif" && format !== "markdown") {
        ctx.ui.notify("Usage: /slop-export <markdown|json|sarif> [project-relative-path]", "warning");
        return;
      }
      try {
        const saved = writeExport(ctx.cwd, lastOutcome.result, format, outputPath);
        ctx.ui.notify(`Exported ${format} evidence to ${saved}`, "info");
      } catch (error) {
        ctx.ui.notify(`Export failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("slop-diagnostics", {
    description: "Inspect effective configuration, runtimes, providers, stores, and safe defaults",
    handler: async (_args: string, ctx: any) => {
      ensureInitialized(ctx);
      ctx.ui.notify(formatDiagnostics(diagnose(ctx.cwd, loadedConfig!)), "info");
    },
  });

  pi.registerCommand("slop-config", {
    description: "Show effective non-secret AI-slop configuration and trust state",
    handler: async (_args: string, ctx: any) => {
      ensureInitialized(ctx);
      ctx.ui.notify(JSON.stringify({ hash: loadedConfig!.hash, sources: loadedConfig!.sources, trustedProject, config: redactConfig(loadedConfig!.config), warnings: loadedConfig!.warnings }, null, 2), "info");
    },
  });

  pi.registerCommand("slop-lab", {
    description: "Create, inspect, validate, explicitly apply, or roll back isolated patch proposals",
    handler: async (args: string, ctx: any) => {
      ensureInitialized(ctx);
      const [action = "list", proposalId] = splitCommandPaths(args);
      try {
        if (action === "list") {
          const laboratory = listLaboratory(ctx.cwd);
          const lines = [
            ...laboratory.proposals.map((proposal) => `${proposal.status} ${proposal.id} ${proposal.risk} ${Object.keys(proposal.fileHashes).join(", ")}`),
            ...laboratory.runs.slice(-20).map((run) => `${run.status} ${run.id} proposal=${run.proposalId} checks=${run.checks.length}`),
          ];
          ctx.ui.notify(lines.join("\n") || "No laboratory proposals or runs", "info");
          return;
        }
        if (action === "create") {
          if (!loadedConfig!.config.execution.commands.length) throw new Error("configure one or more structured execution.commands before creating a laboratory proposal");
          const patch = await ctx.ui.editor("Unified diff for isolated validation", "diff --git a/path b/path\n--- a/path\n+++ b/path\n");
          if (!patch?.trim()) return;
          const risk = await ctx.ui.select("Proposal risk", ["R1", "R2", "R3"]);
          if (!risk) return;
          const obligations = await ctx.ui.input("Proof obligations separated by semicolons", "typecheck; targeted tests; public surface unchanged");
          if (!obligations?.trim()) return;
          const findingIdsText = await ctx.ui.input("Latest-review finding IDs separated by commas", "finding:...");
          if (!findingIdsText?.trim()) return;
          const findingIds = findingIdsText.split(",").map((item: string) => item.trim()).filter(Boolean);
          const commands = loadedConfig!.config.execution.commands.map(splitCommandPaths);
          const confirmed = await ctx.ui.confirm("Create proposal?", loadedConfig!.config.execution.commands.map((command) => redactConfig(command)).join("\n"));
          if (!confirmed) return;
          const proposal = await createProposal(ctx.cwd, {
            patch,
            findingIds,
            risk,
            proofObligations: obligations.split(";").map((item: string) => item.trim()).filter(Boolean),
            commands,
          }, loadedConfig!.config);
          ctx.ui.notify(`Created ${proposal.id}. Validate with /slop-lab verify ${proposal.id}`, "info");
          return;
        }
        if (!proposalId) throw new Error(`Usage: /slop-lab ${action} <proposal-id>`);
        if (action === "verify") {
          const run = await validateProposal(ctx.cwd, proposalId, loadedConfig!.config, trustedProject, ctx.signal);
          ctx.ui.notify(`${run.status.toUpperCase()} ${run.id}\n${run.checks.map((check) => `${check.succeeded ? "PASS" : "FAIL"} ${check.phase} ${check.name}`).join("\n")}${run.diagnostic ? `\n${run.diagnostic}` : ""}`, run.status === "verified" ? "info" : "warning");
          return;
        }
        if (action === "apply") {
          const confirmed = await ctx.ui.confirm("Apply verified proposal?", "This is an explicit source mutation. Hash, risk, deletion, critical-path, and verification guards will be rechecked.");
          if (!confirmed) return;
          const proposal = await applyProposal(ctx.cwd, proposalId);
          ctx.ui.notify(`Applied ${proposal.id}. Use /slop-lab rollback ${proposal.id} to reverse it.`, "warning");
          return;
        }
        if (action === "rollback") {
          const confirmed = await ctx.ui.confirm("Roll back applied proposal?", proposalId);
          if (!confirmed) return;
          const proposal = await rollbackProposal(ctx.cwd, proposalId);
          ctx.ui.notify(`Rolled back ${proposal.id}`, "info");
          return;
        }
        if (action === "show") {
          const laboratory = listLaboratory(ctx.cwd);
          const proposal = laboratory.proposals.find((item) => item.id === proposalId || item.id.startsWith(proposalId));
          if (!proposal) throw new Error(`proposal '${proposalId}' was not found`);
          ctx.ui.notify(JSON.stringify({ ...proposal, patch: `[${Buffer.byteLength(proposal.patch)} byte patch]`, runs: laboratory.runs.filter((run) => run.proposalId === proposal.id) }, null, 2), "info");
          return;
        }
        throw new Error(`unknown laboratory action '${action}'`);
      } catch (error) {
        ctx.ui.notify(`Laboratory: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("slop-experiment", {
    description: "Run bounded property, metamorphic, shadow, mutation, invariant, equality-saturation, and CEGIS checks for pure expressions",
    handler: async (_args: string, ctx: any) => {
      ensureInitialized(ctx);
      const source = await ctx.ui.editor("Expression experiment JSON", JSON.stringify({
        id: "experiment",
        kind: "expression-equivalence",
        original: "x + 0",
        candidate: "x",
        variables: [{ name: "x", type: "integer", minimum: -10, maximum: 10 }],
        properties: [],
        metamorphic: [],
        maximumCases: 10000,
      }, null, 2));
      if (!source) return;
      try {
        const result = runExpressionExperiment(JSON.parse(source) as ExperimentSpec);
        ctx.ui.notify(JSON.stringify(result, null, 2), result.status === "verified" ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`Experiment failed: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("slop-retrieve", {
    description: "Retrieve repository-local graph evidence by semantic token and structural importance",
    handler: async (args: string, ctx: any) => {
      ensureInitialized(ctx);
      if (!args.trim()) {
        ctx.ui.notify("Usage: /slop-retrieve <query>", "warning");
        return;
      }
      try {
        ctx.ui.notify(JSON.stringify(retrieveRepositoryContext(ctx.cwd, args.trim()), null, 2), "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });

  pi.registerCommand("slop-critics", {
    description: "Run opt-in independent advisory critics over cited evidence for one finding",
    handler: async (args: string, ctx: any) => {
      ensureInitialized(ctx);
      try {
        const finding = findingByPrefix(args.trim());
        const evidence = lastOutcome!.result.evidenceRecords.filter(
          (item) => finding.evidenceIds.includes(item.id) || item.source?.filePath === finding.filePath && item.source.end >= finding.start && item.source.start <= finding.end,
        );
        const critics = await runIndependentCritics(finding, evidence, loadedConfig!.config, ctx.model, ctx.modelRegistry, ctx.signal);
        ctx.ui.notify(JSON.stringify(critics, null, 2), critics.some((item) => !item.valid) ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(`Critics: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("slop-formal", {
    description: "Run feature-gated SMT expression equivalence or LLVM translation validation in network isolation",
    handler: async (args: string, ctx: any) => {
      ensureInitialized(ctx);
      const kind = args.trim();
      if (kind !== "smt" && kind !== "translation") {
        ctx.ui.notify("Usage: /slop-formal <smt|translation>", "warning");
        return;
      }
      if (!loadedConfig!.config.execution.commands.length) {
        ctx.ui.notify("Configure an exact solver/validator command first", "warning");
        return;
      }
      const selected = await ctx.ui.select("Formal engine command", loadedConfig!.config.execution.commands);
      if (!selected) return;
      try {
        if (kind === "smt") {
          const source = await ctx.ui.editor("Expression experiment JSON", JSON.stringify({
            id: "smt", kind: "expression-equivalence", original: "x + 0", candidate: "x",
            variables: [{ name: "x", type: "integer", minimum: -10, maximum: 10 }], properties: [], metamorphic: [], maximumCases: 10000,
          }, null, 2));
          if (!source) return;
          const result = await runSmtEquivalence(JSON.parse(source), splitCommandPaths(selected), loadedConfig!.config, trustedProject, ctx.signal);
          ctx.ui.notify(JSON.stringify(result, null, 2), result.status === "verified" ? "info" : "warning");
        } else {
          const source = await ctx.ui.editor("Alive2-compatible LLVM transformation", "");
          if (!source) return;
          const result = await runTranslationValidation(source, splitCommandPaths(selected), loadedConfig!.config, trustedProject, ctx.signal);
          ctx.ui.notify(JSON.stringify(result, null, 2), result.status === "verified" ? "info" : "warning");
        }
      } catch (error) {
        ctx.ui.notify(`Formal verification: ${(error as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("slop-timeline", {
    description: "Show hash-valid session mutations and verification freshness",
    handler: async (_args: string, ctx: any) => {
      const activeLedger = ensureInitialized(ctx);
      const text = formatTimeline(activeLedger.entries(), activeLedger.verificationStatus());
      ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("slop-claims", {
    description: "Verify deterministic completion claims against the current assurance ledger",
    handler: async (args: string, ctx: any) => {
      const activeLedger = ensureInitialized(ctx);
      ctx.ui.notify(args.trim() ? formatClaims(activeLedger.assessClaims(args)) : "Pass claim text after /slop-claims", args.trim() ? "info" : "warning");
    },
  });

  pi.registerTool({
    name: "slop_review",
    label: "AI-slop review",
    description:
      "Read-only, hash-valid review of TypeScript, JavaScript, and Python changes. Reports semantic evidence, delta, verification freshness, and optional claim checks without inferring AI authorship or modifying code.",
    promptSnippet: "Review changed code using semantic evidence, counterevidence, and current verification hashes",
    promptGuidelines: [
      "Use slop_review after code edits and treat findings as review evidence, not proof of AI authorship.",
      "Do not remove code without resolving reported counterevidence, unknowns, and verification requirements.",
    ],
    parameters: Type.Object({
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Project-relative TypeScript, JavaScript, or Python paths; omit for current-session files",
          maxItems: 100,
        }),
      ),
      claims: Type.Optional(Type.String({ description: "Optional completion or review claims to verify against session evidence" })),
    }),

    async execute(
      _toolCallId: string,
      params: { paths?: string[]; claims?: string },
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ) {
      ensureInitialized(ctx);
      if (signal?.aborted) throw new Error("AI-slop review cancelled");
      const paths = params.paths?.length ? params.paths : trackedPaths();
      if (!paths.length) {
        return {
          content: [{ type: "text", text: "No current-session supported file changes are tracked; provide explicit paths." }],
          details: undefined,
        };
      }
      onUpdate?.({ content: [{ type: "text", text: `Reviewing ${paths.length} file(s)...` }] });
      const outcome = await review(ctx.cwd, params.paths?.length ? params.paths : undefined, signal, params.claims);
      lastOutcome = outcome;
      ctx.ui.setStatus("ai-slop", `${outcome.result.findings.length} findings · ${outcome.delta.added.length} new`);
      return { content: [{ type: "text", text: reviewText(outcome, 75) }], details: outcome };
    },

    renderCall(args: { paths?: string[] }, theme: any) {
      const scope = args.paths?.length ? `${args.paths.length} explicit file(s)` : "current-session files";
      return new Text(theme.fg("toolTitle", theme.bold("slop_review ")) + theme.fg("muted", scope), 0, 0);
    },

    renderResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any) {
      if (isPartial) return new Text(theme.fg("warning", "Reviewing..."), 0, 0);
      const outcome = result.details as ReviewOutcome | undefined;
      if (!outcome) return new Text(theme.fg("dim", "No review details"), 0, 0);
      let text = theme.fg(outcome.result.findings.length ? "warning" : "success", resultSummary(outcome));
      if (expanded) text += `\n${theme.fg("dim", reviewText(outcome, 20))}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: "slop_context",
    label: "AI-slop repository context",
    description: "Read-only query of the incremental repository graph for symbols, callers, callees, tests, specifications, and public-surface status.",
    promptSnippet: "Query repository evidence before deciding whether code is redundant or safe to change",
    promptGuidelines: [
      "Use slop_context to inspect callers, tests, specifications, and exports before proposing structural changes.",
      "An absent static edge is not proof that dynamic callers or tests do not exist.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Exact symbol name, qualified name, or project-relative file path" }),
    }),
    async execute(_toolCallId: string, params: { query: string }, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      ensureInitialized(ctx);
      if (signal?.aborted) throw new Error("AI-slop context query cancelled");
      const context = queryContext(ctx.cwd, params.query);
      return {
        content: [{ type: "text", text: JSON.stringify(context, null, 2) }],
        details: context,
      };
    },
    renderCall(args: { query: string }, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("slop_context ")) + theme.fg("muted", args.query), 0, 0);
    },
    renderResult(result: any, { expanded }: { expanded: boolean }, theme: any) {
      const details = result.details as { nodes?: unknown[]; impacts?: unknown[] } | undefined;
      const summary = `${details?.nodes?.length ?? 0} node(s), ${details?.impacts?.length ?? 0} impact result(s)`;
      return new Text(theme.fg("info", expanded ? `${summary}\n${JSON.stringify(details, null, 2)}` : summary), 0, 0);
    },
  });

  pi.registerTool({
    name: "slop_propose",
    label: "AI-slop isolated proposal",
    description: "Create and validate a user-reviewable unified diff in separate network-isolated worktrees. Never applies the patch to the real checkout.",
    promptSnippet: "Validate a concrete patch without mutating the working tree",
    promptGuidelines: [
      "Only propose the smallest patch supported by findings and repository context.",
      "Select exact configured commands and explicit proof obligations; this tool never applies the patch.",
    ],
    parameters: Type.Object({
      patch: Type.String({ description: "Standard unified diff with diff --git headers" }),
      findingIds: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
      risk: Type.String({ description: "R1, R2, or R3" }),
      proofObligations: Type.Array(Type.String(), { maxItems: 50 }),
      commands: Type.Array(Type.Array(Type.String(), { maxItems: 50 }), { maxItems: 20 }),
      experiments: Type.Optional(Type.Array(Type.String({ description: "Expression experiment JSON" }), { maxItems: 20 })),
    }),
    async execute(
      _toolCallId: string,
      params: { patch: string; findingIds?: string[]; risk: string; proofObligations: string[]; commands: string[][]; experiments?: string[] },
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: any,
    ) {
      ensureInitialized(ctx);
      if (!new Set(["R1", "R2", "R3"]).has(params.risk)) throw new Error("risk must be R1, R2, or R3");
      onUpdate?.({ content: [{ type: "text", text: "Creating isolated proposal..." }] });
      const proposal = await createProposal(ctx.cwd, {
        patch: params.patch,
        findingIds: params.findingIds,
        risk: params.risk as "R1" | "R2" | "R3",
        proofObligations: params.proofObligations,
        commands: params.commands,
        experiments: params.experiments?.map((value) => JSON.parse(value) as ExperimentSpec),
      }, loadedConfig!.config);
      onUpdate?.({ content: [{ type: "text", text: "Running baseline and candidate validation in network-isolated worktrees..." }] });
      const run = await validateProposal(ctx.cwd, proposal.id, loadedConfig!.config, trustedProject, signal);
      return {
        content: [{ type: "text", text: `${run.status.toUpperCase()} ${proposal.id}\n${run.checks.map((check) => `${check.succeeded ? "PASS" : "FAIL"} ${check.phase} ${check.name}`).join("\n")}${run.diagnostic ? `\n${run.diagnostic}` : ""}\nThe real checkout was not modified.` }],
        details: { proposal: { ...proposal, patch: undefined }, run },
      };
    },
    renderCall(args: { risk: string; commands: unknown[] }, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("slop_propose ")) + theme.fg("muted", `${args.risk}, ${args.commands.length} command(s)`), 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const status = result.details?.run?.status ?? "unknown";
      return new Text(theme.fg(status === "verified" ? "success" : "warning", `proposal ${status}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "slop_verify",
    label: "AI-slop proposal verification",
    description: "Re-run a stored proposal in clean network-isolated baseline and candidate worktrees. Never applies source changes.",
    promptSnippet: "Re-verify a stored isolated patch proposal",
    parameters: Type.Object({ proposalId: Type.String({ description: "Proposal ID or unique prefix" }) }),
    async execute(_toolCallId: string, params: { proposalId: string }, signal: AbortSignal | undefined, onUpdate: any, ctx: any) {
      ensureInitialized(ctx);
      onUpdate?.({ content: [{ type: "text", text: "Re-validating proposal..." }] });
      const run = await validateProposal(ctx.cwd, params.proposalId, loadedConfig!.config, trustedProject, signal);
      return {
        content: [{ type: "text", text: `${run.status.toUpperCase()} ${run.id}\n${run.checks.map((check) => `${check.succeeded ? "PASS" : "FAIL"} ${check.phase} ${check.name}`).join("\n")}` }],
        details: run,
      };
    },
    renderCall(args: { proposalId: string }, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("slop_verify ")) + theme.fg("muted", args.proposalId), 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const status = result.details?.status ?? "unknown";
      return new Text(theme.fg(status === "verified" ? "success" : "warning", `verification ${status}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "slop_experiment",
    label: "AI-slop bounded experiment",
    description: "Run pure-expression property, metamorphic, shadow, mutation, invariant, equality-saturation, regression-case, and CEGIS checks with explicit finite bounds.",
    promptSnippet: "Test a narrow pure-expression equivalence claim with counterexample generation",
    parameters: Type.Object({
      id: Type.String(),
      original: Type.String(),
      candidate: Type.String(),
      variables: Type.Array(Type.Object({
        name: Type.String(),
        type: Type.String({ description: "integer or boolean" }),
        minimum: Type.Optional(Type.Number()),
        maximum: Type.Optional(Type.Number()),
      }), { maxItems: 20 }),
      properties: Type.Array(Type.String(), { maxItems: 50 }),
      metamorphic: Type.Array(Type.Object({
        name: Type.String(),
        transform: Type.Record(Type.String(), Type.String()),
        relation: Type.String({ description: "equal, not-equal, nondecreasing, or nonincreasing" }),
      }), { maxItems: 50 }),
      maximumCases: Type.Number(),
    }),
    async execute(_toolCallId: string, params: any, signal: AbortSignal | undefined) {
      if (signal?.aborted) throw new Error("experiment cancelled");
      const result = runExpressionExperiment({ ...params, kind: "expression-equivalence" } as ExperimentSpec);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
    renderCall(args: { id: string }, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("slop_experiment ")) + theme.fg("muted", args.id), 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const status = result.details?.status ?? "unknown";
      return new Text(theme.fg(status === "verified" ? "success" : status === "refuted" ? "error" : "warning", `experiment ${status}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "slop_retrieve",
    label: "AI-slop repository retrieval",
    description: "Retrieve local repository graph context ranked by token match, public-surface status, and structural importance. No source is sent remotely.",
    promptSnippet: "Retrieve repository-local evidence for an ambiguous finding",
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
    async execute(_toolCallId: string, params: { query: string; limit?: number }, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      if (signal?.aborted) throw new Error("retrieval cancelled");
      const result = retrieveRepositoryContext(ctx.cwd, params.query, params.limit);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
    renderCall(args: { query: string }, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("slop_retrieve ")) + theme.fg("muted", args.query), 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      return new Text(theme.fg("info", `${result.details?.results?.length ?? 0} retrieved node(s)`), 0, 0);
    },
  });

  pi.registerTool({
    name: "slop_formal",
    label: "AI-slop formal verification",
    description: "Run opt-in network-isolated SMT expression equivalence or LLVM translation validation. Unsupported domains abstain with explicit assumptions.",
    promptSnippet: "Attempt bounded formal verification without treating timeout or unknown as success",
    parameters: Type.Object({
      kind: Type.String({ description: "smt or translation" }),
      command: Type.Array(Type.String(), { maxItems: 20 }),
      spec: Type.Optional(Type.String({ description: "Expression experiment JSON for SMT" })),
      llvm: Type.Optional(Type.String({ description: "Alive2-compatible LLVM transformation" })),
    }),
    async execute(_toolCallId: string, params: { kind: string; command: string[]; spec?: string; llvm?: string }, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      ensureInitialized(ctx);
      const result = params.kind === "smt"
        ? await runSmtEquivalence(JSON.parse(params.spec ?? "{}"), params.command, loadedConfig!.config, trustedProject, signal)
        : params.kind === "translation"
          ? await runTranslationValidation(params.llvm ?? "", params.command, loadedConfig!.config, trustedProject, signal)
          : (() => { throw new Error("kind must be smt or translation"); })();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
    renderCall(args: { kind: string }, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("slop_formal ")) + theme.fg("muted", args.kind), 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const status = result.details?.status ?? "unknown";
      return new Text(theme.fg(status === "verified" ? "success" : status === "refuted" ? "error" : "warning", `formal ${status}`), 0, 0);
    },
  });

  pi.registerTool({
    name: "slop_critics",
    label: "AI-slop evidence critics",
    description: "Run four opt-in independent advisory critics over an evidence bundle. Responses must cite existing evidence IDs and never authorize fixes.",
    promptSnippet: "Seek independent support and counterexamples for one finding",
    parameters: Type.Object({ findingId: Type.String() }),
    async execute(_toolCallId: string, params: { findingId: string }, signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
      ensureInitialized(ctx);
      const finding = findingByPrefix(params.findingId);
      const evidence = lastOutcome!.result.evidenceRecords.filter(
        (item) => finding.evidenceIds.includes(item.id) || item.source?.filePath === finding.filePath && item.source.end >= finding.start && item.source.start <= finding.end,
      );
      const result = await runIndependentCritics(finding, evidence, loadedConfig!.config, ctx.model, ctx.modelRegistry, signal);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
    renderCall(args: { findingId: string }, theme: any) {
      return new Text(theme.fg("toolTitle", theme.bold("slop_critics ")) + theme.fg("muted", args.findingId), 0, 0);
    },
    renderResult(result: any, _options: any, theme: any) {
      const assessments = Array.isArray(result.details) ? result.details : [];
      return new Text(theme.fg("info", `${assessments.length} critic assessment(s); advisory only`), 0, 0);
    },
  });
}
