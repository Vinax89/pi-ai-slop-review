import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { AiSlopConfig } from "../core/config.ts";
import { createScanResult, fingerprint } from "../core/schema.ts";
import { SCHEMA_VERSION, type EvidenceRecord, type Finding, type ScanResult } from "../types.ts";

function packageName(finding: Finding): string | undefined {
  if (finding.ruleId !== "dependency.unresolved") return undefined;
  return finding.message.match(/Module '([^']+)'/)?.[1];
}

function declaredPackages(rootDir: string): { names: Set<string>; errors: string[] } {
  const names = new Set<string>();
  const errors: string[] = [];
  const manifestPath = path.join(rootDir, "package.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      for (const group of [manifest?.dependencies, manifest?.devDependencies, manifest?.peerDependencies, manifest?.optionalDependencies]) {
        if (group && typeof group === "object") for (const name of Object.keys(group)) names.add(name);
      }
    } catch (error) {
      errors.push(`package.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const requirementName of ["requirements.txt", "requirements-dev.txt"]) {
    const filePath = path.join(rootDir, requirementName);
    if (!existsSync(filePath)) continue;
    try {
      for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z0-9_.-]+)/);
        if (match && !line.trimStart().startsWith(("#"))) names.add(match[1].toLowerCase().replace(/[_.]+/g, "-"));
      }
    } catch (error) {
      errors.push(`${requirementName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { names, errors };
}

function lockfileContains(rootDir: string, name: string): { found: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const lockName of ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "Pipfile.lock"]) {
    const filePath = path.join(rootDir, lockName);
    if (!existsSync(filePath)) continue;
    try {
      if (readFileSync(filePath, "utf8").includes(name)) return { found: true, errors };
    } catch (error) {
      errors.push(`${lockName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { found: false, errors };
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function nearestName(name: string, declared: Set<string>): { name: string; distance: number } | undefined {
  let nearest: { name: string; distance: number } | undefined;
  for (const candidate of declared) {
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (!nearest || distance < nearest.distance) nearest = { name: candidate, distance };
  }
  return nearest && nearest.distance <= 2 ? nearest : undefined;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<{ status: number; value?: any }> {
  const timeout = AbortSignal.timeout(8_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "pi-ai-slop-review/1" },
    redirect: "error",
    signal: combined,
  });
  if (!response.ok) return { status: response.status };
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error("registry response exceeds 2 MiB");
  return { status: response.status, value: JSON.parse(text) };
}

function githubProject(repository: unknown): string | undefined {
  const raw = typeof repository === "string" ? repository : (repository as any)?.url;
  if (typeof raw !== "string") return undefined;
  const match = raw.match(/github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/i);
  return match?.[1];
}

async function registryFacts(
  name: string,
  config: AiSlopConfig,
  signal?: AbortSignal,
): Promise<{ summary: string[]; details: Record<string, unknown> }> {
  const summary: string[] = [];
  const details: Record<string, unknown> = {};
  if (!config.network.enabled) return { summary: ["network provenance lookup disabled"], details: { network: false } };
  const allowed = new Set(config.network.registries);
  if (allowed.has("npm")) {
    const response = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name).replace(/^%40/, "@")}`, signal);
    details.npmStatus = response.status;
    if (response.status === 200) {
      const latest = response.value?.["dist-tags"]?.latest;
      const maintainers = Array.isArray(response.value?.maintainers) ? response.value.maintainers.length : 0;
      const published = latest ? response.value?.time?.[latest] : undefined;
      Object.assign(details, { npmLatest: latest, npmMaintainers: maintainers, npmLatestPublished: published });
      summary.push(`npm registry contains '${name}'${latest ? ` at ${latest}` : ""}`);
      const project = githubProject(response.value?.repository);
      if (project && allowed.has("openssf")) {
        const scorecard = await fetchJson(`https://api.securityscorecards.dev/projects/github.com/${project}`, signal);
        details.openSsfStatus = scorecard.status;
        if (scorecard.status === 200) {
          details.openSsfScore = scorecard.value?.score;
          summary.push(`OpenSSF Scorecard reported ${String(scorecard.value?.score ?? "unknown")}/10 for ${project}`);
        }
      }
    } else if (response.status === 404) summary.push(`npm registry does not contain '${name}'`);
  }
  if (allowed.has("pypi")) {
    const response = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, signal);
    details.pypiStatus = response.status;
    if (response.status === 200) {
      const version = response.value?.info?.version;
      const releases = Array.isArray(response.value?.releases?.[version]) ? response.value.releases[version] : [];
      Object.assign(details, { pypiLatest: version, pypiLatestPublished: releases[0]?.upload_time_iso_8601 });
      summary.push(`PyPI contains '${name}'${version ? ` at ${version}` : ""}`);
    } else if (response.status === 404) summary.push(`PyPI does not contain '${name}'`);
  }
  if (!summary.length) summary.push("no approved registry supplied provenance evidence");
  return { summary, details };
}

export async function collectDependencyProvenance(
  rootDir: string,
  seed: ScanResult,
  config: AiSlopConfig,
  signal?: AbortSignal,
): Promise<ScanResult> {
  const declared = declaredPackages(rootDir);
  const evidenceRecords: EvidenceRecord[] = [];
  const errors = [...declared.errors];
  for (const finding of seed.findings) {
    const name = packageName(finding);
    if (!name) continue;
    const rootName = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
    const normalized = rootName.toLowerCase().replace(/[_.]+/g, "-");
    const declaredMatch = declared.names.has(rootName) || declared.names.has(normalized);
    const lockfile = lockfileContains(rootDir, rootName);
    errors.push(...lockfile.errors);
    const nearest = nearestName(normalized, declared.names);
    let remote = { summary: ["network provenance lookup disabled"], details: { network: false } as Record<string, unknown> };
    try {
      remote = await registryFacts(rootName, config, signal);
    } catch (error) {
      errors.push(`${rootName}: ${error instanceof Error ? error.message : String(error)}`);
      remote = { summary: ["registry provenance lookup failed closed"], details: { network: config.network.enabled } };
    }
    const summary = [
      declaredMatch ? `package name '${rootName}' is declared` : `package name '${rootName}' is not directly declared`,
      lockfile.found ? "name appears in a recognized lockfile" : "name was not found in recognized lockfiles",
      ...(nearest && nearest.name !== normalized ? [`name is edit distance ${nearest.distance} from declared '${nearest.name}'`] : []),
      ...remote.summary,
    ];
    evidenceRecords.push({
      schemaVersion: SCHEMA_VERSION,
      id: fingerprint("evidence", { findingId: finding.id, provider: "dependency-provenance", summary }),
      providerId: "dependency-provenance",
      providerVersion: "1",
      kind: "provenance",
      summary: summary.join("; "),
      strength: "C2",
      source: {
        filePath: finding.filePath,
        line: finding.line,
        column: finding.column,
        start: finding.start,
        end: finding.end,
        sourceHash: finding.sourceHash,
      },
      details: { declared: declaredMatch, locked: lockfile.found, nearest, manifestDiagnostics: declared.errors, lockfileDiagnostics: lockfile.errors, ...remote.details },
    });
  }
  return createScanResult({
    engine: "provider-federation",
    engineVersion: "dependency-provenance 1",
    rootDir,
    providerId: "dependency-provenance",
    providerVersion: "1",
    providerCapabilities: ["dependencies"],
    evidenceRecords,
    scannedFiles: evidenceRecords.flatMap((item) => (item.source ? [item.source.filePath] : [])),
    findings: [],
    skipped: [...new Set(errors)].map((reason) => ({ filePath: "<provenance>", reason, providerId: "dependency-provenance" })),
  });
}
