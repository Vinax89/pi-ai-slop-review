import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assessScanCompleteness } from "./core/completeness.ts";
import { isInside, nearestExistingParent } from "./core/paths.ts";
import { canonicalJson, sha256 } from "./core/schema.ts";
import { rankFindings } from "./core/severity.ts";
import { StateStore } from "./core/store.ts";
import { loadRulePolicies } from "./policy/rules.ts";
import type { Finding, ScanResult } from "./types.ts";

export type ExportFormat = "json" | "sarif" | "markdown";

const PACKAGE_VERSION = String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);

function sarifLevel(finding: Finding): "error" | "warning" | "note" {
  if (finding.classification === "defect" && finding.confidence !== "C1") return "error";
  if (finding.confidence === "C1") return "note";
  return "warning";
}

function sarifResult(finding: Finding, suppressed = false): Record<string, unknown> {
  return {
    ruleId: finding.ruleId,
    level: sarifLevel(finding),
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: finding.filePath },
          region: {
            startLine: finding.line,
            startColumn: finding.column,
            charOffset: finding.start,
            charLength: Math.max(0, finding.end - finding.start),
          },
        },
      },
    ],
    suppressions: suppressed ? [{ kind: "external", status: "accepted", justification: "Suppressed by repository/user policy" }] : undefined,
    properties: {
      findingId: finding.id,
      anchor: finding.anchor,
      classification: finding.classification,
      confidence: finding.confidence,
      risk: finding.risk,
      maximumAction: finding.maximumAction,
      sourceHash: finding.sourceHash,
      evidence: finding.evidence,
      counterEvidence: finding.counterEvidence,
      unknown: finding.unknown,
    },
  };
}

export function toSarif(result: ScanResult): Record<string, unknown> {
  const completeness = result.completeness ?? assessScanCompleteness(result);
  const all = [...result.findings, ...result.suppressedFindings];
  const rules = [...new Set(all.map((finding) => finding.ruleId))].sort().map((ruleId) => ({
    id: ruleId,
    name: ruleId,
    shortDescription: { text: ruleId },
  }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Pi AI-Slop Review",
            semanticVersion: PACKAGE_VERSION,
            rules,
          },
        },
        automationDetails: { id: result.scanId },
        invocations: [{ executionSuccessful: completeness.status === "complete" }],
        results: [
          ...result.findings.map((finding) => sarifResult(finding)),
          ...result.suppressedFindings.map((finding) => sarifResult(finding, true)),
        ],
        properties: {
          schemaVersion: result.schemaVersion,
          generatedAt: result.generatedAt,
          scope: result.scope,
          providers: result.providers,
          policyDecisions: result.policyDecisions,
          ruleHealth: result.ruleHealth,
          completeness,
        },
      },
    ],
  };
}

function markdownText(value: unknown): string {
  return String(value)
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replace(/[\\`*_\[\]~]/g, "\\$&");
}

function findingList(title: string, values: string[]): string[] {
  return values.length ? [`#### ${title}`, ...values.map((value) => `- ${markdownText(value)}`), ""] : [];
}

function sourceContext(
  rootDir: string | undefined,
  finding: Finding,
  cache: Map<string, { hash: string; lines: string[] }>,
): string[] {
  if (!rootDir) return [];
  try {
    const absolute = realpathSync(path.resolve(rootDir, finding.filePath));
    if (!isInside(rootDir, absolute)) return [];
    let cached = cache.get(absolute);
    if (!cached) {
      const source = readFileSync(absolute, "utf8");
      cached = { hash: sha256(source), lines: source.split(/\r?\n/) };
      cache.set(absolute, cached);
    }
    if (cached.hash !== finding.sourceHash || finding.line > cached.lines.length) return [];
    const first = Math.max(1, finding.line - 2);
    const last = Math.min(cached.lines.length, finding.line + 2);
    const width = String(last).length;
    const excerpt = cached.lines.slice(first - 1, last).map((line, index) => {
      const lineNumber = first + index;
      const displayed = line.length > 240 ? `${line.slice(0, 240)}…` : line;
      return `    ${lineNumber === finding.line ? ">" : " "} ${String(lineNumber).padStart(width)} | ${displayed}`;
    });
    return ["#### Representative Source", "", ...excerpt, ""];
  } catch {
    return [];
  }
}

export function toMarkdown(result: ScanResult, rootDir?: string): string {
  const completeness = result.completeness ?? assessScanCompleteness(result);
  const rulePolicies = loadRulePolicies();
  const ranked = rankFindings(result.findings, result.policyDecisions);
  const actionCounts = new Map<Finding["maximumAction"], number>();
  const families = new Map<string, typeof ranked>();
  const hotspots = new Map<string, { count: number; rules: Set<string>; highest: number }>();
  const priorityCounts = [0, 0, 0, 0];
  for (const item of ranked) {
    const { finding, decision } = item;
    const finalAction = decision?.finalAction ?? finding.maximumAction;
    actionCounts.set(finalAction, (actionCounts.get(finalAction) ?? 0) + 1);
    const family = families.get(finding.ruleId);
    if (family) family.push(item);
    else families.set(finding.ruleId, [item]);
    const hotspot = hotspots.get(finding.filePath);
    if (hotspot) {
      hotspot.count += 1;
      hotspot.rules.add(finding.ruleId);
      hotspot.highest = Math.max(hotspot.highest, item.score);
    } else {
      hotspots.set(finding.filePath, { count: 1, rules: new Set([finding.ruleId]), highest: item.score });
    }
    priorityCounts[item.score >= 85 ? 0 : item.score >= 65 ? 1 : item.score >= 40 ? 2 : 3] += 1;
  }
  const actionWeight: Record<Finding["maximumAction"], number> = {
    ignore: 0,
    observe: 1,
    propose: 2,
    "delegate-safe-fix": 3,
  };
  const familySummaries = new Map<string, {
    representative: (typeof ranked)[number];
    actionSummary: string;
    disposition: Finding["maximumAction"];
    missingEvidence: string;
    nextAction: string;
  }>();
  for (const [ruleId, items] of families) {
    let representative = items[0]!;
    for (let index = 1; index < items.length; index += 1) {
      const candidate = items[index]!;
      const candidateAction = candidate.decision?.finalAction ?? candidate.finding.maximumAction;
      const representativeAction = representative.decision?.finalAction ?? representative.finding.maximumAction;
      if (actionWeight[candidateAction] > actionWeight[representativeAction] ||
        (candidateAction === representativeAction && candidate.score > representative.score)) representative = candidate;
    }
    const familyActionCounts = new Map<Finding["maximumAction"], number>();
    for (const item of items) {
      const action = item.decision?.finalAction ?? item.finding.maximumAction;
      familyActionCounts.set(action, (familyActionCounts.get(action) ?? 0) + 1);
    }
    const disposition = representative.decision?.finalAction ?? representative.finding.maximumAction;
    familySummaries.set(ruleId, {
      representative,
      disposition,
      actionSummary: (["delegate-safe-fix", "propose", "observe", "ignore"] as const)
        .flatMap((action) => familyActionCounts.has(action)
          ? [`${action === "delegate-safe-fix" ? "Delegate safe fix" : `${action[0]!.toUpperCase()}${action.slice(1)}`} (${familyActionCounts.get(action)})`]
          : [])
        .join(", "),
      missingEvidence: representative.finding.unknown[0] ?? "Whether the reported behavior violates the local contract",
      nextAction: rulePolicies.get(ruleId)?.remediationSteps[0] ??
        "Inspect callers and contracts before deciding whether any change is justified.",
    });
  }
  const decisionsRequired = [...familySummaries.values()].filter((summary) => summary.disposition !== "ignore").length;
  const proposedChanges = (actionCounts.get("propose") ?? 0) + (actionCounts.get("delegate-safe-fix") ?? 0);
  const sourceCache = new Map<string, { hash: string; lines: string[] }>();
  let sourceRoot: string | undefined;
  try {
    sourceRoot = rootDir ? realpathSync(rootDir) : undefined;
  } catch {
    sourceRoot = undefined;
  }
  const lines = [
    "# AI-Slop Review — Human Decision Report",
    "",
    "> Review priority orders investigation. It is not defect severity, proof of incorrectness, or authorization to change code.",
    "",
    "## Scan Summary",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Scan ID | ${markdownText(result.scanId)} |`,
    `| Generated | ${markdownText(result.generatedAt)} |`,
    `| Scope | ${markdownText(result.scope.mode)} |`,
    `| Files scanned | ${result.scannedFiles.length} |`,
    `| Returned findings | ${result.findings.length} |`,
    `| Finding families | ${families.size} |`,
    `| Decisions required | ${decisionsRequired} |`,
    `| Policy proposals | ${proposedChanges} |`,
    `| Suppressed findings | ${result.suppressedFindings.length} |`,
    `| Skipped or omitted items | ${result.skipped.length} |`,
    `| Completeness | ${markdownText(completeness.status)} |`,
    "",
    "## Human Decision Summary",
    "",
    "| Current disposition | Meaning | Findings |",
    "| --- | --- | ---: |",
    `| Observe | Investigate only; no code change is authorized | ${actionCounts.get("observe") ?? 0} |`,
    `| Propose | A human may draft a narrow patch for validation | ${actionCounts.get("propose") ?? 0} |`,
    `| Delegate safe fix | Only an authoritative released fix may be delegated | ${actionCounts.get("delegate-safe-fix") ?? 0} |`,
    `| Ignore | No remediation is recommended | ${actionCounts.get("ignore") ?? 0} |`,
    "",
  ];
  if ((actionCounts.get("observe") ?? 0) === ranked.length && ranked.length) {
    lines.push(`> All ${ranked.length} returned findings are review-only. Review the ${families.size} family representative(s), not a ${ranked.length}-item patch queue.`, "");
  }
  if (completeness.reasons.length) {
    lines.push("> **Incomplete review:** This result must not be interpreted as a clean scan.", "", ...completeness.reasons.map((reason) => `- ${markdownText(reason)}`), "");
  }
  lines.push(
    "## Decision Queue",
    "",
    "| # | Finding family | Candidates | Priority | Current disposition | Missing evidence | Next action |",
    "| ---: | --- | ---: | ---: | --- | --- | --- |",
    ...[...families.entries()].map(([ruleId, items], index) => {
      const summary = familySummaries.get(ruleId)!;
      return `| ${index + 1} | ${markdownText(ruleId)} | ${items.length} | ${summary.representative.score}/100 | ${markdownText(summary.actionSummary)} | ${markdownText(summary.missingEvidence)} | ${markdownText(summary.nextAction)} |`;
    }),
    "",
    "## Review Workflow",
    "",
    "1. Use the decision queue to choose the highest-priority unresolved family.",
    "2. Inspect its representative source, supporting evidence, counterevidence, and missing evidence.",
    "3. Perform the listed investigation and record exactly one feedback outcome.",
    "4. Change code only after an accepted decision with a contract-preserving fix and runnable verification.",
    "",
    "## Decision Outcomes",
    "",
    "| Human conclusion | Feedback | Effect |",
    "| --- | --- | --- |",
    "| The finding is valid and a verifiable fix is understood | accepted | Permit a narrow proposal |",
    "| The behavior is intentional or contractually required | intentional | Keep the code; optionally suppress narrowly |",
    "| The claim may be valid but its contract or impact is unknown | missing-context | Keep observing and gather context |",
    "| The detector is wrong or the evidence does not support its claim | insufficient-evidence | Make no code change |",
    "",
  );
  if (hotspots.size) {
    lines.push(
      "## Hotspots",
      "",
      "| File | Candidates | Families | Highest review priority |",
      "| --- | ---: | ---: | ---: |",
      ...[...hotspots.entries()]
        .sort(([leftPath, left], [rightPath, right]) => right.count - left.count || leftPath.localeCompare(rightPath))
        .slice(0, 10)
        .map(([filePath, hotspot]) => `| ${markdownText(filePath)} | ${hotspot.count} | ${hotspot.rules.size} | ${hotspot.highest}/100 |`),
      "",
    );
  }
  lines.push("## Family Decisions", "");
  let familyNumber = 0;
  for (const [ruleId, items] of families) {
    familyNumber += 1;
    const { representative } = familySummaries.get(ruleId)!;
    const { finding, decision } = representative;
    const finalAction = decision?.finalAction ?? finding.maximumAction;
    const ownEvidence = new Set([...finding.evidenceIds, ...finding.counterEvidenceIds]);
    const contextualEvidence = result.evidenceRecords.filter((record) => ownEvidence.has(record.id) || Boolean(
      record.source &&
      record.source.filePath === finding.filePath &&
      record.source.sourceHash === finding.sourceHash &&
      record.source.end >= finding.start &&
      record.source.start <= finding.end,
    ));
    const providers = [...new Set(contextualEvidence.map((record) => record.providerId))].sort();
    const testFiles = [...new Set(contextualEvidence.flatMap((record) => {
      const values = record.details?.testFiles;
      const linked = Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
      return record.kind === "test" && record.source ? [...linked, record.source.filePath] : linked;
    }))].sort();
    const callerLocations = [...new Set(contextualEvidence.flatMap((record) => {
      const values = record.details?.callerLocations;
      return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
    }))].sort();
    const specificationFiles = [...new Set(contextualEvidence.flatMap((record) => {
      const values = record.details?.specificationFiles;
      return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
    }))].sort();
    const policy = rulePolicies.get(ruleId);
    const remediation = policy?.remediationSteps.length
      ? policy.remediationSteps
      : ["Inspect callers and contracts, then make the smallest change that addresses the reported behavior."];
    const missingEvidence = [...finding.unknown.slice(1)];
    if (!callerLocations.length) missingEvidence.push("No linked caller was found for the representative.");
    if (!testFiles.length) missingEvidence.push("No linked regression test was found for the representative.");
    if (!specificationFiles.length) missingEvidence.push("No governing specification was linked to the representative.");
    if (!missingEvidence.length) missingEvidence.push("No additional evidence gaps were identified beyond the decision question.");
    const investigation = [
      `Query repository context with /slop-context ${finding.filePath}.`,
      remediation[0]!,
    ];
    if (callerLocations.length) investigation.push(`Inspect linked callers: ${callerLocations.slice(0, 5).join(", ")}${callerLocations.length > 5 ? ` (+${callerLocations.length - 5} more)` : ""}.`);
    if (testFiles.length) investigation.push(`Inspect linked tests: ${testFiles.slice(0, 5).join(", ")}${testFiles.length > 5 ? ` (+${testFiles.length - 5} more)` : ""}.`);
    if (specificationFiles.length) investigation.push(`Check governing specifications: ${specificationFiles.slice(0, 5).join(", ")}${specificationFiles.length > 5 ? ` (+${specificationFiles.length - 5} more)` : ""}.`);
    const verification: string[] = [];
    if (testFiles.length) {
      verification.push(`Run linked test file${testFiles.length === 1 ? "" : "s"}: ${testFiles.slice(0, 5).join(", ")}${testFiles.length > 5 ? ` (+${testFiles.length - 5} more)` : ""}.`);
    } else {
      verification.push("Add or identify the smallest caller-level regression test for the accepted behavior.");
    }
    if (callerLocations.length) {
      verification.push(`Exercise linked caller${callerLocations.length === 1 ? "" : "s"}: ${callerLocations.slice(0, 5).join(", ")}${callerLocations.length > 5 ? ` (+${callerLocations.length - 5} more)` : ""}.`);
    }
    if (specificationFiles.length) {
      verification.push(`Check behavior against: ${specificationFiles.slice(0, 5).join(", ")}${specificationFiles.length > 5 ? ` (+${specificationFiles.length - 5} more)` : ""}.`);
    }
    verification.push(...(policy?.verificationSteps.length
      ? policy.verificationSteps
      : ["Run the smallest test or static check that proves the affected behavior."]));
    lines.push(
      `### Decision ${familyNumber} of ${families.size} — ${markdownText(ruleId)}`,
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| Candidates | ${items.length} |`,
      `| Review priority | ${representative.score}/100 |`,
      `| Current disposition | ${finalAction === "observe" ? "Observe — no code change authorized" : markdownText(finalAction)} |`,
      `| Risk / confidence | ${finding.risk}/${finding.confidence} |`,
      `| Representative | ${markdownText(finding.filePath)}:${finding.line}:${finding.column} |`,
      `| Finding ID | ${markdownText(finding.id)} |`,
      `| Detectors | ${providers.length ? providers.map(markdownText).join(", ") : "detector only"} |`,
      "",
      "#### Claim",
      "",
      markdownText(finding.message),
      "",
      ...sourceContext(sourceRoot, finding, sourceCache),
      ...findingList("Supporting Evidence", finding.evidence.length ? finding.evidence : ["No supporting evidence was linked."]),
      ...findingList("Counterevidence", finding.counterEvidence.length ? finding.counterEvidence : ["No linked counterevidence was found."]),
      "#### Decision Needed",
      "",
      `> ${markdownText(finding.unknown[0] ?? "Determine whether the reported behavior violates the local contract.")}`,
      "",
      ...findingList("Missing Evidence", missingEvidence),
      ...findingList("Next Investigation", investigation),
      ...findingList("Policy Notes", decision?.reasons ?? []),
      "#### Record the Decision",
      "",
      "Choose exactly one outcome defined above:",
      "",
      "```text",
      `/slop-feedback ${finding.id} accepted <reason>`,
      `/slop-feedback ${finding.id} intentional <reason>`,
      `/slop-feedback ${finding.id} missing-context <reason>`,
      `/slop-feedback ${finding.id} insufficient-evidence <reason>`,
      "```",
      "",
    );
    if (finalAction === "ignore") {
      lines.push("#### Current Recommendation", "", "No remediation is recommended under the current policy disposition.", "");
    } else {
      const changeSteps = remediation.length > 1
        ? remediation.slice(1)
        : ["Make the smallest contract-preserving change supported by the accepted decision."];
      const acceptedRemediation = finalAction === "delegate-safe-fix"
        ? ["Confirm the fix comes from an authoritative released source and applies to this exact version.", ...changeSteps]
        : changeSteps;
      lines.push(
        "#### Only If Accepted",
        "",
        "**Possible remediation**",
        "",
        ...acceptedRemediation.map((step) => `- ${markdownText(step)}`),
        "",
        "**Required verification**",
        "",
        ...verification.map((step) => `- ${markdownText(step)}`),
        "",
      );
    }
    lines.push(
      `**Other occurrences:** ${Math.max(0, items.length - 1)} · Open \`/slop-findings\` for the complete candidate list.`,
      "",
    );
  }
  lines.push(
    "## Review Priority Method",
    "",
    "Score = 60% risk + 25% confidence + 15% policy evidence. It orders review candidates; it does not establish severity, impact, or correctness.",
    "",
    "| Score band | Candidates |",
    "| --- | ---: |",
    `| 85–100 | ${priorityCounts[0]} |`,
    `| 65–84 | ${priorityCounts[1]} |`,
    `| 40–64 | ${priorityCounts[2]} |`,
    `| 0–39 | ${priorityCounts[3]} |`,
    "",
  );
  const providerCounts = new Map<string, number>();
  for (const provider of result.providers) providerCounts.set(provider.status, (providerCounts.get(provider.status) ?? 0) + 1);
  lines.push(
    "## Provider Health",
    "",
    `**Summary:** ${(["completed", "degraded", "failed", "skipped"] as const).map((status) => `${providerCounts.get(status) ?? 0} ${status}`).join(", ")}.`,
    "",
  );
  const unhealthyProviders = result.providers.filter((provider) => provider.status !== "completed");
  if (unhealthyProviders.length) {
    lines.push(
      "| Provider | Status | Version | Diagnostic |",
      "| --- | --- | --- | --- |",
      ...unhealthyProviders.map((provider) => `| ${markdownText(provider.id)} | ${provider.status} | ${markdownText(provider.version)} | ${markdownText(provider.diagnostic ?? "")} |`),
      "",
    );
  }
  if (result.suppressedFindings.length) {
    const suppressed = new Map<string, number>();
    for (const finding of result.suppressedFindings) suppressed.set(finding.ruleId, (suppressed.get(finding.ruleId) ?? 0) + 1);
    lines.push(
      "## Suppressed Findings",
      "",
      "| Rule | Findings |",
      "| --- | ---: |",
      ...[...suppressed].map(([ruleId, count]) => `| ${markdownText(ruleId)} | ${count} |`),
      "",
    );
  }
  if (result.ruleHealth.length) {
    const ruleHealthCounts = new Map<string, number>();
    for (const health of result.ruleHealth) ruleHealthCounts.set(health.status, (ruleHealthCounts.get(health.status) ?? 0) + 1);
    const exceptions = result.ruleHealth.filter((health) => health.status !== "healthy");
    lines.push(
      "## Rule Health",
      "",
      `**Summary:** ${(["healthy", "insufficient-data", "observe-only", "disabled"] as const).map((status) => `${ruleHealthCounts.get(status) ?? 0} ${status}`).join(", ")}.`,
      "",
    );
    if (exceptions.length) {
      lines.push(
        "| Rule | Status | Accepted / Samples | Precision |",
        "| --- | --- | ---: | ---: |",
        ...exceptions.slice(0, 20).map((health) => `| ${markdownText(health.ruleId)} | ${health.status} | ${health.accepted} / ${health.samples} | ${health.precision?.toFixed(2) ?? "—"} |`),
        ...(exceptions.length > 20 ? [`| … | ${exceptions.length - 20} additional exceptions | — | — |`] : []),
        "",
      );
    }
  }
  if (result.skipped.length) {
    const skippedGroups = new Map<string, { provider: string; reason: string; count: number; example: string }>();
    for (const skipped of result.skipped) {
      const provider = skipped.providerId ?? "native";
      const key = `${provider}\0${skipped.reason}`;
      const group = skippedGroups.get(key);
      if (group) group.count += 1;
      else skippedGroups.set(key, { provider, reason: skipped.reason, count: 1, example: skipped.filePath });
    }
    lines.push(
      "## Skipped or Omitted Items",
      "",
      "| Provider | Reason | Count | Example |",
      "| --- | --- | ---: | --- |",
      ...[...skippedGroups.values()].map((group) => `| ${markdownText(group.provider)} | ${markdownText(group.reason)} | ${group.count} | ${markdownText(group.example)} |`),
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function serializeExport(result: ScanResult, format: ExportFormat, rootDir?: string): string {
  if (format === "markdown") return toMarkdown(result, rootDir);
  return `${format === "sarif" ? JSON.stringify(toSarif(result), null, 2) : canonicalJson(result)}\n`;
}

export function writeExport(
  rootDir: string,
  result: ScanResult,
  format: ExportFormat,
  requestedPath?: string,
  stateRoot?: string,
): string {
  let outputPath: string;
  if (requestedPath) {
    const root = realpathSync(rootDir);
    outputPath = path.resolve(root, requestedPath);
    if (!isInside(root, outputPath) || !isInside(root, realpathSync(nearestExistingParent(outputPath)))) {
      throw new Error("export path resolves outside the project root");
    }
  } else {
    const store = new StateStore(rootDir, stateRoot);
    const extension = format === "sarif" ? "sarif.json" : format === "markdown" ? "md" : "json";
    outputPath = path.join(store.directory, "exports", `${result.scanId.replace(/[^A-Za-z0-9_.-]/g, "-")}.${extension}`);
  }
  mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  const cleanupTemporary = (): void => {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Preserve the original export failure if cleanup itself is unavailable.
    }
  };
  let descriptor: number | undefined;
  try {
    const opened = openSync(temporaryPath, "wx", 0o600);
    descriptor = opened;
    try {
      writeFileSync(opened, serializeExport(result, format, rootDir), "utf8");
    } finally {
      closeSync(opened);
      descriptor = undefined;
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The original write/close failure is more useful to callers.
      }
    }
    cleanupTemporary();
    throw error;
  }
  try {
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    cleanupTemporary();
    throw error;
  }
  return outputPath;
}
