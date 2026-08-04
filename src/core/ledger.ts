import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { AiSlopConfig, VerificationCommandConfig } from "./config.ts";
import { isInside, nearestExistingParent } from "./paths.ts";
import { canonicalFilePath, canonicalJson, fingerprint, sha256 } from "./schema.ts";
import {
  SCHEMA_VERSION,
  type ClaimAssessment,
  type Finding,
  type LedgerEvent,
  type MutationLedgerEvent,
  type ScanResult,
  type VerificationLedgerEvent,
} from "../types.ts";

const MUTATION_TOOLS = new Set(["edit", "write", "ctx_edit"]);
const COMMAND_TOOLS = new Set(["bash", "ctx_shell"]);

interface PendingMutation {
  kind: "mutation";
  toolCallId: string;
  toolName: string;
  filePath: string;
  absolutePath: string;
  beforeHash: string | null;
  beforeText: string;
}

interface PendingVerification {
  kind: "verification";
  toolCallId: string;
  toolName: string;
  command: string;
  config?: VerificationCommandConfig;
}

type PendingEvent = PendingMutation | PendingVerification;

export interface ToolEvent {
  toolCallId?: unknown;
  toolName?: unknown;
  input?: unknown;
  isError?: unknown;
}

export interface VerificationStatus {
  filePath: string;
  contentHash: string | null;
  fresh: VerificationLedgerEvent[];
  stale: VerificationLedgerEvent[];
}

export interface ScanDelta {
  baselineId?: string;
  currentId: string;
  added: Finding[];
  resolved: Finding[];
  unchanged: Finding[];
  changed: Array<{ before: Finding; after: Finding }>;
}

function securePath(rootDir: string, rawPath: string): { absolutePath: string; filePath: string } | undefined {
  const root = realpathSync(rootDir);
  const absolute = path.resolve(root, rawPath.replace(/^@/, ""));
  if (!isInside(root, absolute)) return undefined;
  const existing = nearestExistingParent(absolute);
  const realExisting = realpathSync(existing);
  if (!isInside(root, realExisting)) return undefined;
  if (existsSync(absolute) && !isInside(root, realpathSync(absolute))) return undefined;
  const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute;
  return { absolutePath: canonical, filePath: canonicalFilePath(root, canonical) };
}

function fileText(filePath: string): string {
  if (!existsSync(filePath)) return "";
  const stats = statSync(filePath);
  if (!stats.isFile()) return "";
  return readFileSync(filePath, "utf8");
}

function fileHash(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const stats = statSync(filePath);
  if (!stats.isFile()) return null;
  return sha256(readFileSync(filePath));
}

function changedRange(before: string, after: string): { start: number; beforeEnd: number; afterEnd: number } {
  let start = 0;
  const common = Math.min(before.length, after.length);
  while (start < common && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return { start, beforeEnd, afterEnd };
}

function eventInput(event: ToolEvent): Record<string, unknown> | undefined {
  return event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : undefined;
}

function verificationConfig(command: string, config: AiSlopConfig): VerificationCommandConfig | undefined {
  return config.verification.commands.find((item) => {
    try {
      return new RegExp(item.pattern).test(command);
    } catch {
      return command.includes(item.pattern);
    }
  });
}

function matches(filePath: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    try {
      return path.matchesGlob(filePath, pattern);
    } catch {
      return filePath === pattern || filePath.startsWith(pattern.replace(/\*+.*$/, ""));
    }
  });
}

function findingMap(findings: Finding[]): Map<string, Finding> {
  return new Map(findings.map((finding) => [finding.id, finding]));
}

function validLedgerEvent(value: unknown): value is LedgerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (event.schemaVersion !== SCHEMA_VERSION || typeof event.id !== "string" || typeof event.toolCallId !== "string" ||
    typeof event.toolName !== "string" || typeof event.timestamp !== "string" || typeof event.succeeded !== "boolean") return false;
  if (event.kind === "mutation") {
    const range = event.changedRange;
    if (!range || typeof range !== "object" || Array.isArray(range)) return false;
    const changed = range as Record<string, unknown>;
    return (event.beforeHash === null || typeof event.beforeHash === "string") &&
      (event.afterHash === null || typeof event.afterHash === "string") && typeof event.filePath === "string" &&
      Number.isSafeInteger(changed.start) && (changed.start as number) >= 0 &&
      Number.isSafeInteger(changed.beforeEnd) && (changed.beforeEnd as number) >= (changed.start as number) &&
      Number.isSafeInteger(changed.afterEnd) && (changed.afterEnd as number) >= (changed.start as number);
  }
  if (event.kind !== "verification") return false;
  const hashes = event.contentHashes;
  return typeof event.command === "string" && typeof event.verificationKind === "string" &&
    Array.isArray(event.authoritativeFor) && event.authoritativeFor.every((item) => typeof item === "string") &&
    hashes !== null && typeof hashes === "object" && !Array.isArray(hashes) &&
    Object.values(hashes as Record<string, unknown>).every((item) => typeof item === "string");
}

export class AssuranceLedger {
  readonly rootDir: string;
  readonly config: AiSlopConfig;
  private events: LedgerEvent[] = [];
  private readonly pending = new Map<string, PendingEvent>();

  constructor(rootDir: string, config: AiSlopConfig) {
    this.rootDir = rootDir;
    this.config = config;
  }
  reconstruct(events: LedgerEvent[]): void {
    this.events = events
      .filter(validLedgerEvent)
      .map((event) =>
        event.kind === "mutation"
          ? { ...event, filePath: canonicalFilePath(this.rootDir, event.filePath) }
          : {
              ...event,
              authoritativeFor: event.authoritativeFor.map((filePath) => canonicalFilePath(this.rootDir, filePath)),
              contentHashes: Object.fromEntries(
                Object.entries(event.contentHashes).map(([filePath, hash]) => [canonicalFilePath(this.rootDir, filePath), hash]),
              ),
            },
      );
    this.pending.clear();
  }

  entries(): LedgerEvent[] {
    return structuredClone(this.events);
  }

  touchedPaths(): string[] {
    return [...new Set(this.events.flatMap((event) => (event.kind === "mutation" && event.succeeded ? [event.filePath] : [])))].sort();
  }

  captureToolCall(event: ToolEvent): void {
    if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string") return;
    const input = eventInput(event);
    if (!input) return;
    if (MUTATION_TOOLS.has(event.toolName)) {
      if (typeof input.path !== "string") return;
      const resolved = securePath(this.rootDir, input.path);
      if (!resolved) return;
      this.pending.set(event.toolCallId, {
        kind: "mutation",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...resolved,
        beforeHash: fileHash(resolved.absolutePath),
        beforeText: fileText(resolved.absolutePath),
      });
      return;
    }
    if (COMMAND_TOOLS.has(event.toolName) && typeof input.command === "string") {
      this.pending.set(event.toolCallId, {
        kind: "verification",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        command: input.command,
        config: verificationConfig(input.command, this.config),
      });
    }
  }

  captureToolResult(event: ToolEvent): LedgerEvent | undefined {
    if (typeof event.toolCallId !== "string") return undefined;
    const pending = this.pending.get(event.toolCallId);
    this.pending.delete(event.toolCallId);
    if (!pending) return undefined;
    const timestamp = new Date().toISOString();
    const succeeded = event.isError !== true;
    let ledgerEvent: LedgerEvent;
    if (pending.kind === "mutation") {
      const afterText = fileText(pending.absolutePath);
      const afterHash = fileHash(pending.absolutePath);
      ledgerEvent = {
        schemaVersion: SCHEMA_VERSION,
        id: fingerprint("ledger", {
          afterHash,
          beforeHash: pending.beforeHash,
          filePath: pending.filePath,
          succeeded,
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
        }),
        kind: "mutation",
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        filePath: pending.filePath,
        beforeHash: pending.beforeHash,
        afterHash,
        changedRange: changedRange(pending.beforeText, afterText),
        succeeded,
        timestamp,
      } satisfies MutationLedgerEvent;
    } else {
      const authoritativeFor = pending.config?.authoritativeFor ?? [];
      const contentHashes = Object.fromEntries(
        this.touchedPaths()
          .filter((filePath) => !authoritativeFor.length || matches(filePath, authoritativeFor))
          .flatMap((filePath) => {
            const resolved = securePath(this.rootDir, filePath);
            const hash = resolved ? fileHash(resolved.absolutePath) : null;
            return hash ? [[filePath, hash]] : [];
          }),
      );
      ledgerEvent = {
        schemaVersion: SCHEMA_VERSION,
        id: fingerprint("ledger", {
          authoritativeFor,
          command: pending.command,
          contentHashes,
          succeeded,
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          verificationKind: pending.config?.kind ?? "unclassified",
        }),
        kind: "verification",
        toolCallId: pending.toolCallId,
        toolName: pending.toolName,
        command: pending.command,
        verificationKind: pending.config?.kind ?? "unclassified",
        authoritativeFor,
        contentHashes,
        succeeded,
        timestamp,
      } satisfies VerificationLedgerEvent;
    }
    this.events.push(ledgerEvent);
    return ledgerEvent;
  }

  verificationStatus(paths = this.touchedPaths()): VerificationStatus[] {
    const verifications = this.events.filter((event): event is VerificationLedgerEvent => event.kind === "verification");
    return paths.map((rawPath) => {
      const filePath = canonicalFilePath(this.rootDir, rawPath);
      const resolved = securePath(this.rootDir, filePath);
      const contentHash = resolved ? fileHash(resolved.absolutePath) : null;
      const relevant = verifications.filter(
        (event) => event.authoritativeFor.length && matches(filePath, event.authoritativeFor) && filePath in event.contentHashes,
      );
      return {
        filePath,
        contentHash,
        fresh: relevant.filter((event) => event.succeeded && contentHash !== null && event.contentHashes[filePath] === contentHash),
        stale: relevant.filter((event) => !event.succeeded || contentHash === null || event.contentHashes[filePath] !== contentHash),
      };
    });
  }

  assessClaims(text: string, context: { apiChanged?: boolean; dependenciesChanged?: boolean; behaviorProven?: boolean } = {}): ClaimAssessment[] {
    const specifications: Array<{ type: ClaimAssessment["type"]; pattern: RegExp }> = [
      { type: "tests-passed", pattern: /\b(?:all\s+)?tests?\s+(?:have\s+)?passed\b/i },
      { type: "checks-passed", pattern: /\b(?:all\s+)?(?:checks|validation|ci)\s+(?:have\s+)?passed\b/i },
      { type: "no-api-change", pattern: /\b(?:no|without)\s+(?:public\s+)?api\s+changes?\b/i },
      { type: "no-dependency-change", pattern: /\b(?:no|without)\s+dependenc(?:y|ies)\s+changes?\b/i },
      { type: "scope-only", pattern: /\b(?:only|just)\s+(?:the\s+)?(?:requested|specified|scoped)\s+(?:files?|changes?)\b/i },
      { type: "behavior-preserved", pattern: /\b(?:behavior|behaviour|semantics?)\s+(?:is|are|was|were)?\s*(?:preserved|unchanged|equivalent)\b/i },
    ];
    return specifications.flatMap(({ type, pattern }) => {
      const match = text.match(pattern);
      if (!match) return [];
      let status: ClaimAssessment["status"] = "unverifiable";
      const evidence: string[] = [];
      if (type === "tests-passed" || type === "checks-passed") {
        const statuses = this.verificationStatus();
        const kinds = type === "tests-passed" ? new Set(["unit-test", "integration-test"]) : undefined;
        const latestByCommand = new Map<string, VerificationLedgerEvent>();
        for (const event of this.events) {
          if (event.kind !== "verification" || event.verificationKind === "unclassified" || (kinds && !kinds.has(event.verificationKind))) continue;
          latestByCommand.set(event.command, event);
        }
        const relevant = [...latestByCommand.values()];
        const freshIds = new Set(statuses.flatMap((item) => item.fresh.map((event) => event.id)));
        const failed = relevant.filter((event) => !event.succeeded);
        if (failed.length) {
          status = "refuted";
          evidence.push(`${failed.length} configured verification run(s) failed`);
        } else if (relevant.length && relevant.every((event) => freshIds.has(event.id))) {
          status = "supported";
          evidence.push(`${relevant.length} configured verification run(s) passed against current hashes`);
        } else {
          evidence.push("no complete fresh configured verification evidence covers current changes");
        }
      } else if (type === "no-api-change" && context.apiChanged !== undefined) {
        status = context.apiChanged ? "refuted" : "supported";
        evidence.push(context.apiChanged ? "public-surface comparison found changes" : "public-surface comparison found no changes");
      } else if (type === "no-dependency-change" && context.dependenciesChanged !== undefined) {
        status = context.dependenciesChanged ? "refuted" : "supported";
        evidence.push(context.dependenciesChanged ? "dependency manifests or lockfiles changed" : "dependency comparison found no changes");
      } else if (type === "behavior-preserved" && context.behaviorProven !== undefined) {
        status = context.behaviorProven ? "supported" : "refuted";
        evidence.push(context.behaviorProven ? "configured behavioral verification succeeded" : "behavioral verification found a difference");
      } else {
        evidence.push("required structured comparison evidence was not supplied");
      }
      return [{
        schemaVersion: SCHEMA_VERSION,
        id: fingerprint("claim", { claim: match[0], status, type }),
        claim: match[0],
        type,
        status,
        evidence,
        timestamp: new Date().toISOString(),
      } satisfies ClaimAssessment];
    });
  }
}

export function diffScans(current: ScanResult, baseline?: ScanResult): ScanDelta {
  if (!baseline) {
    return { currentId: current.scanId, added: current.findings, resolved: [], unchanged: [], changed: [] };
  }
  const before = findingMap(baseline.findings);
  const after = findingMap(current.findings);
  const added: Finding[] = [];
  const unchanged: Finding[] = [];
  const changed: Array<{ before: Finding; after: Finding }> = [];
  for (const finding of current.findings) {
    const previous = before.get(finding.id);
    if (!previous) {
      added.push(finding);
      continue;
    }
    const sourceChanged =
      previous.sourceHash !== finding.sourceHash &&
      previous.line === finding.line &&
      previous.column === finding.column &&
      previous.start === finding.start &&
      previous.end === finding.end;
    const equivalent =
      previous.confidence === finding.confidence &&
      previous.maximumAction === finding.maximumAction &&
      previous.message === finding.message &&
      previous.classification === finding.classification &&
      previous.risk === finding.risk &&
      canonicalJson(previous.evidence) === canonicalJson(finding.evidence) &&
      canonicalJson(previous.counterEvidence) === canonicalJson(finding.counterEvidence) &&
      canonicalJson(previous.unknown) === canonicalJson(finding.unknown) &&
      !sourceChanged;
    if (equivalent) unchanged.push(finding);
    else changed.push({ before: previous, after: finding });
  }
  const resolved = baseline.findings.filter((finding) => !after.has(finding.id));
  return { baselineId: baseline.scanId, currentId: current.scanId, added, resolved, unchanged, changed };
}
