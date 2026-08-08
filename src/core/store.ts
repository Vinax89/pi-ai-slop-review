import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SCHEMA_VERSION, type PersistedState, type StoredSession } from "../types.ts";
import { assessScanCompleteness } from "./completeness.ts";
import { isScanResult, canonicalJson, sha256 } from "./schema.ts";

function now(): string {
  return new Date().toISOString();
}

function initialState(repositoryId: string): PersistedState {
  const createdAt = now();
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    repositoryId,
    createdAt,
    updatedAt: createdAt,
    sessions: {},
    suppressions: [],
    feedback: [],
    baselines: {},
    proposals: [],
    labRuns: [],
    verdicts: [],
  };
}

function validateState(value: unknown, repositoryId: string): PersistedState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("state is not an object");
  const candidate = value as Partial<PersistedState>;
  if (candidate.schemaVersion !== SCHEMA_VERSION) throw new Error(`unsupported state schemaVersion ${String(candidate.schemaVersion)}`);
  if (candidate.repositoryId !== repositoryId) throw new Error("state repository identifier does not match");
  if (candidate.proposals === undefined) candidate.proposals = [];
  if (candidate.labRuns === undefined) candidate.labRuns = [];
  if (candidate.verdicts === undefined) candidate.verdicts = [];
  if (
    !Number.isSafeInteger(candidate.revision) ||
    !candidate.sessions || typeof candidate.sessions !== "object" || Array.isArray(candidate.sessions) ||
    !Array.isArray(candidate.suppressions) || !Array.isArray(candidate.feedback) ||
    !candidate.baselines || typeof candidate.baselines !== "object" || Array.isArray(candidate.baselines) ||
    !Array.isArray(candidate.proposals) || !Array.isArray(candidate.labRuns) ||
    !Array.isArray(candidate.verdicts) ||
    typeof candidate.createdAt !== "string" || typeof candidate.updatedAt !== "string"
  ) {
    throw new Error("state is missing required fields");
  }
  candidate.proposals = candidate.proposals.map((proposal) => ({ ...proposal, experiments: proposal.experiments ?? [] }));
  candidate.labRuns = candidate.labRuns.map((run) => ({ ...run, experimentResults: run.experimentResults ?? [] }));
  candidate.feedback = candidate.feedback.map((record) => ({
    ...record,
    findingConfidence: record.findingConfidence ?? "C1",
    maximumAction: record.maximumAction ?? "observe",
    providerIds: record.providerIds ?? [],
    evidenceScore: record.evidenceScore ?? 0,
    unsafe: record.unsafe ?? false,
  }));
  const validVerdicts = new Set(["confirmed", "dismissed", "needs-context"]);
  candidate.verdicts = candidate.verdicts.filter((record) =>
    record && typeof record.findingId === "string" && typeof record.ruleId === "string" &&
    typeof record.filePath === "string" && Number.isSafeInteger(record.line) &&
    typeof record.anchor === "string" && typeof record.sourceHash === "string" &&
    typeof record.verdict === "string" && validVerdicts.has(record.verdict) &&
    typeof record.evidence === "string" && typeof record.scanId === "string" &&
    typeof record.createdAt === "string" && typeof record.repositoryId === "string");
  const migrateScan = (scan: PersistedState["baselines"][string]): void => {
    if (!isScanResult(scan)) throw new Error("state contains an invalid persisted scan result");
    scan.suppressedFindings ??= [];
    scan.policyDecisions ??= [];
    scan.ruleHealth ??= [];
    scan.completeness ??= assessScanCompleteness(scan);
  };
  for (const scan of Object.values(candidate.baselines)) migrateScan(scan);
  for (const session of Object.values(candidate.sessions)) {
    if (!session || typeof session !== "object" || !Array.isArray(session.scans)) throw new Error("state contains an invalid session");
    session.claims ??= [];
    for (const scan of session.scans) migrateScan(scan);
  }
  return candidate as PersistedState;
}
function boundSession(session: StoredSession): StoredSession {
  return {
    ...session,
    events: session.events.slice(-1_000),
    scans: session.scans.slice(-20),
    claims: session.claims.slice(-100),
  };
}

function boundState(state: PersistedState): PersistedState {
  const baselines = Object.fromEntries(
    Object.entries(state.baselines)
      .sort(([, left], [, right]) => right.generatedAt.localeCompare(left.generatedAt))
      .slice(0, 20),
  );
  return {
    ...state,
    suppressions: state.suppressions.slice(-1_000),
    feedback: state.feedback.slice(-1_000),
    baselines,
    proposals: state.proposals.slice(-100),
    labRuns: state.labRuns.slice(-100),
    verdicts: state.verdicts.slice(-2_000),
  };
}

interface StateSnapshot {
  state: PersistedState;
  primaryValid: boolean;
}


export class StateStore {
  readonly repositoryId: string;
  readonly directory: string;
  readonly statePath: string;
  readonly backupPath: string;
  readonly lockPath: string;
  readonly sessionDatabasePath: string;
  constructor(rootDir: string, stateRoot = path.join(homedir(), ".pi", "agent", "ai-slop", "state")) {
    this.repositoryId = sha256(path.resolve(rootDir));
    this.directory = path.join(stateRoot, this.repositoryId.slice(0, 32));
    this.statePath = path.join(this.directory, "state.json");
    this.backupPath = path.join(this.directory, "state.backup.json");
    this.lockPath = path.join(this.directory, "state.lock");
    this.clearMarkerPath = path.join(this.directory, "state.cleared");
    this.sessionDatabasePath = path.join(this.directory, "sessions.sqlite");
  }

  readonly clearMarkerPath: string;


  load(): PersistedState {
    return this.loadSnapshot().state;
  }

  private loadSnapshot(): StateSnapshot {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (!existsSync(this.statePath)) return { state: initialState(this.repositoryId), primaryValid: false };
    try {
      const state = validateState(JSON.parse(readFileSync(this.statePath, "utf8")), this.repositoryId);
      this.migrateSessions(state.sessions);
      state.sessions = {};
      return { state, primaryValid: true };
    } catch (primaryError) {
      let backupDiagnostic = "";
      if (existsSync(this.backupPath)) {
        try {
          const state = validateState(JSON.parse(readFileSync(this.backupPath, "utf8")), this.repositoryId);
          this.migrateSessions(state.sessions);
          state.sessions = {};
          return { state, primaryValid: false };
        } catch (backupError) {
          backupDiagnostic = `; backup recovery failed: ${backupError instanceof Error ? backupError.message : String(backupError)}`;
        }
      }
      throw new Error(`cannot load AI-slop state: ${(primaryError as Error).message}${backupDiagnostic}`);
    }
  }

  save(state: PersistedState): PersistedState {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = this.acquireLock();
    try {
      return this.saveLocked(state);
    } finally {
      closeSync(lock);
      rmSync(this.lockPath, { force: true });
    }
  }

  private saveLocked(state: PersistedState, snapshot = this.loadSnapshot()): PersistedState {
    const current = snapshot.state;
    if (existsSync(this.clearMarkerPath)) {
      let marker: { clearedAt?: unknown; revision?: unknown };
      try {
        marker = JSON.parse(readFileSync(this.clearMarkerPath, "utf8")) as { clearedAt?: unknown; revision?: unknown };
      } catch (error) {
        throw new Error(`cannot load AI-slop clear marker: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (typeof marker.clearedAt !== "string" || !Number.isFinite(Date.parse(marker.clearedAt)) ||
        !Number.isSafeInteger(marker.revision) || (marker.revision as number) < 0) {
        throw new Error("AI-slop state clear marker is invalid");
      }
      if (typeof state.updatedAt !== "string" || !Number.isFinite(Date.parse(state.updatedAt))) {
        throw new Error("state updatedAt is invalid");
      }
      if (state.revision >= (marker.revision as number) && Date.parse(state.updatedAt) <= Date.parse(marker.clearedAt)) {
        throw new Error("state snapshot was invalidated by clear");
      }
    }
    if (state.revision !== current.revision) {
      throw new Error(`state revision conflict: expected ${state.revision}, found ${current.revision}`);
    }
    const temporaryPath = path.join(this.directory, `state.${process.pid}.${Date.now()}.tmp`);
    try {
      let next = boundState(validateState(
        { ...state, revision: state.revision + 1, updatedAt: now(), schemaVersion: SCHEMA_VERSION },
        this.repositoryId,
      ));
      this.migrateSessions(next.sessions);
      next = { ...next, sessions: {} };
      if (snapshot.primaryValid) copyFileSync(this.statePath, this.backupPath);
      writeFileSync(temporaryPath, `${canonicalJson(next)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporaryPath, this.statePath);
      return next;
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  update(mutator: (state: PersistedState) => PersistedState | void): PersistedState {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = this.acquireLock();
    try {
      const snapshot = this.loadSnapshot();
      const draft = structuredClone(snapshot.state);
      const candidate = mutator(draft);
      return this.saveLocked(candidate === undefined ? draft : candidate, snapshot);
    } finally {
      closeSync(lock);
      rmSync(this.lockPath, { force: true });
    }
  }
  saveSession(session: StoredSession): void {
    this.migrateSessions({ [session.id]: session });
  }

  loadSessions(limit = 100): StoredSession[] {
    if (!existsSync(this.sessionDatabasePath)) return [];
    const database = this.openSessionDatabase();
    try {
      const rows = database.prepare("SELECT payload FROM sessions ORDER BY updated_at DESC, id LIMIT ?").all(limit) as Array<{ payload: string }>;
      return rows.flatMap(({ payload }) => {
        try {
          const session = JSON.parse(payload) as StoredSession;
          return session && typeof session.id === "string" && Array.isArray(session.scans) ? [session] : [];
        } catch {
          return [];
        }
      });
    } finally {
      database.close();
    }
  }

  private migrateSessions(sessions: Record<string, StoredSession>): void {
    if (!Object.keys(sessions).length) return;
    const database = this.openSessionDatabase();
    try {
      const upsert = database.prepare("INSERT INTO sessions(id, branch_id, updated_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET branch_id=excluded.branch_id, updated_at=excluded.updated_at, payload=excluded.payload");
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const session of Object.values(sessions)) {
          const bounded = boundSession(session);
          upsert.run(bounded.id, bounded.branchId, bounded.updatedAt, canonicalJson(bounded));
        }
        database.exec("DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY updated_at DESC, id LIMIT 100)");
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  }

  private openSessionDatabase(): DatabaseSync {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.sessionDatabasePath);
    chmodSync(this.sessionDatabasePath, 0o600);
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, branch_id TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions(updated_at DESC, id)");
    return database;
  }

  clear(): void {
    const lock = this.acquireLock();
    try {
      let revision = 0;
      if (existsSync(this.statePath)) {
        try {
          const candidate = JSON.parse(readFileSync(this.statePath, "utf8")) as { revision?: unknown };
          if (Number.isSafeInteger(candidate.revision) && (candidate.revision as number) >= 0) revision = candidate.revision as number;
        } catch {
          // Clearing remains available when the primary state is corrupt.
        }
      }
      rmSync(this.statePath, { force: true });
      rmSync(this.backupPath, { force: true });
      rmSync(this.sessionDatabasePath, { force: true });
      rmSync(`${this.sessionDatabasePath}-wal`, { force: true });
      rmSync(`${this.sessionDatabasePath}-shm`, { force: true });
      writeFileSync(this.clearMarkerPath, JSON.stringify({ clearedAt: now(), revision }), { encoding: "utf8", mode: 0o600 });
    } finally {
      closeSync(lock);
      rmSync(this.lockPath, { force: true });
    }
  }

  private acquireLock(): number {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const open = (): number => {
      const descriptor = openSync(this.lockPath, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: now() }), "utf8");
      return descriptor;
    };
    try {
      return open();
    } catch (error: unknown) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw new Error(`cannot create AI-slop state lock: ${error instanceof Error ? error.message : String(error)}`);
      let stale = false;
      try {
        const lock = JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid?: unknown };
        if (typeof lock.pid === "number" && Number.isSafeInteger(lock.pid)) {
          try {
            process.kill(lock.pid, 0);
          } catch (processError: unknown) {
            stale = typeof processError === "object" && processError !== null && "code" in processError && processError.code === "ESRCH";
          }
        } else stale = Date.now() - statSync(this.lockPath).mtimeMs > 10 * 60_000;
      } catch {
        stale = Date.now() - statSync(this.lockPath).mtimeMs > 10 * 60_000;
      }
      if (stale) {
        rmSync(this.lockPath, { force: true });
        return open();
      }
      throw new Error("AI-slop state is locked by another live process");
    }
  }
}
