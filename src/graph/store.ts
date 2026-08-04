import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { sha256 } from "../core/schema.ts";
import type { GraphEdge, GraphFileFacts, GraphNode, ImpactResult, PublicSurfaceEntry } from "./types.ts";

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("repository graph metadata is not an object");
  return parsed;
}

function rowNode(row: any): GraphNode {
  return {
    id: String(row.id),
    filePath: String(row.file_path),
    kind: row.kind,
    name: String(row.name),
    qualifiedName: String(row.qualified_name),
    start: Number(row.start),
    end: Number(row.end),
    exported: Boolean(row.exported),
    signature: row.signature === null ? undefined : String(row.signature),
    bodyHash: row.body_hash === null ? undefined : String(row.body_hash),
    metadata: parseMetadata(row.metadata),
  };
}

function rowEdge(row: any): GraphEdge {
  return {
    id: String(row.id),
    filePath: String(row.file_path),
    fromId: String(row.from_id),
    toId: String(row.to_id),
    kind: row.kind,
    confidence: row.confidence,
    metadata: parseMetadata(row.metadata),
  };
}

export class GraphStore {
  readonly repositoryId: string;
  readonly directory: string;
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(rootDir: string, stateRoot = path.join(homedir(), ".pi", "agent", "ai-slop", "graph")) {
    this.repositoryId = sha256(path.resolve(rootDir));
    this.directory = path.join(stateRoot, this.repositoryId.slice(0, 32));
    this.databasePath = path.join(this.directory, "context.sqlite");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(this.databasePath);
    chmodSync(this.databasePath, 0o600);
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  updateFile(facts: GraphFileFacts): boolean {
    return this.updateFiles([facts]) === 1;
  }

  updateFiles(files: GraphFileFacts[]): number {
    if (!files.length) return 0;
    const current = this.database.prepare("SELECT source_hash, content_hash FROM files WHERE path = ?");
    const nodeIds = this.database.prepare("SELECT id FROM nodes WHERE file_path = ?");
    const deleteEdges = this.database.prepare("DELETE FROM edges WHERE file_path = ?");
    const deleteIncomingEdge = this.database.prepare("DELETE FROM edges WHERE to_id = ?");
    const deleteNodes = this.database.prepare("DELETE FROM nodes WHERE file_path = ?");
    const upsertFile = this.database.prepare(
      "INSERT INTO files(path, source_hash, content_hash, language, updated_at) VALUES(?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET source_hash=excluded.source_hash, content_hash=excluded.content_hash, language=excluded.language, updated_at=excluded.updated_at",
    );
    const insertNode = this.database.prepare(
      "INSERT OR REPLACE INTO nodes(id, file_path, kind, name, qualified_name, start, end, exported, signature, body_hash, metadata) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertEdge = this.database.prepare(
      "INSERT OR REPLACE INTO edges(id, file_path, from_id, to_id, kind, confidence, metadata) VALUES(?, ?, ?, ?, ?, ?, ?)",
    );
    let updated = 0;
    const updatedAt = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const facts of files) {
        const existing = current.get(facts.filePath) as { source_hash?: string; content_hash?: string } | undefined;
        const cacheHash = facts.cacheHash ?? facts.sourceHash;
        if (existing?.source_hash === cacheHash) continue;
        if (existing) {
          const nextNodeIds = new Set(facts.nodes.map((node) => node.id));
          for (const row of nodeIds.all(facts.filePath) as Array<{ id: string }>) {
            if (!nextNodeIds.has(String(row.id))) deleteIncomingEdge.run(row.id);
          }
        }
        deleteEdges.run(facts.filePath);
        deleteNodes.run(facts.filePath);
        upsertFile.run(facts.filePath, cacheHash, facts.sourceHash, facts.language, updatedAt);
        for (const node of facts.nodes) {
          insertNode.run(
            node.id,
            node.filePath,
            node.kind,
            node.name,
            node.qualifiedName,
            node.start,
            node.end,
            node.exported ? 1 : 0,
            node.signature ?? null,
            node.bodyHash ?? null,
            JSON.stringify(node.metadata),
          );
        }
        for (const edge of facts.edges) {
          insertEdge.run(edge.id, edge.filePath, edge.fromId, edge.toId, edge.kind, edge.confidence, JSON.stringify(edge.metadata));
        }
        updated += 1;
      }
      this.database.exec("COMMIT");
      return updated;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  cachedFiles(paths: Iterable<string>): Map<string, { cacheHash: string; contentHash?: string }> {
    const current = this.database.prepare("SELECT source_hash, content_hash FROM files WHERE path = ?");
    const cached = new Map<string, { cacheHash: string; contentHash?: string }>();
    for (const filePath of paths) {
      const row = current.get(filePath) as { source_hash?: string; content_hash?: string | null } | undefined;
      if (row?.source_hash) cached.set(filePath, {
        cacheHash: row.source_hash,
        contentHash: row.content_hash ?? undefined,
      });
    }
    return cached;
  }

  removeFiles(paths: string[]): void {
    if (!paths.length) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const nodeIds = this.database.prepare("SELECT id FROM nodes WHERE file_path = ?");
      const deleteEdges = this.database.prepare("DELETE FROM edges WHERE file_path = ?");
      const deleteIncomingEdge = this.database.prepare("DELETE FROM edges WHERE to_id = ?");
      const deleteNodes = this.database.prepare("DELETE FROM nodes WHERE file_path = ?");
      const deleteFile = this.database.prepare("DELETE FROM files WHERE path = ?");
      for (const filePath of paths) {
        for (const row of nodeIds.all(filePath) as Array<{ id: string }>) deleteIncomingEdge.run(row.id);
        deleteEdges.run(filePath);
        deleteNodes.run(filePath);
        deleteFile.run(filePath);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  files(): string[] {
    return this.database.prepare("SELECT path FROM files ORDER BY path").all().map((row: any) => String(row.path));
  }

  nodes(filePath?: string): GraphNode[] {
    const rows = filePath
      ? this.database.prepare("SELECT * FROM nodes WHERE file_path = ? ORDER BY start, id").all(filePath)
      : this.database.prepare("SELECT * FROM nodes ORDER BY file_path, start, id").all();
    return rows.map(rowNode);
  }
  *nodePages(pageSize = 500): Generator<GraphNode[]> {
    let after = "";
    while (true) {
      const rows = this.database.prepare("SELECT * FROM nodes WHERE id > ? ORDER BY id LIMIT ?").all(after, pageSize) as Array<Record<string, unknown>>;
      if (!rows.length) return;
      yield rows.map(rowNode);
      after = String(rows[rows.length - 1]!.id);
    }
  }


  *nodePagesForFiles(filePaths: Iterable<string>, pageSize = 500): Generator<GraphNode[]> {
    const query = this.database.prepare("SELECT * FROM nodes WHERE file_path = ? AND id > ? ORDER BY id LIMIT ?");
    for (const filePath of filePaths) {
      let after = "";
      while (true) {
        const rows = query.all(filePath, after, pageSize) as Array<Record<string, unknown>>;
        if (!rows.length) break;
        yield rows.map(rowNode);
        after = String(rows[rows.length - 1]!.id);
      }
    }
  }

  edges(filePath?: string): GraphEdge[] {
    const rows = filePath
      ? this.database.prepare("SELECT * FROM edges WHERE file_path = ? ORDER BY id").all(filePath)
      : this.database.prepare("SELECT * FROM edges ORDER BY file_path, id").all();
    return rows.map(rowEdge);
  }
  *edgePages(filePath: string, pageSize = 500): Generator<GraphEdge[]> {
    let after = "";
    while (true) {
      const rows = this.database.prepare("SELECT * FROM edges WHERE file_path = ? AND id > ? ORDER BY id LIMIT ?").all(filePath, after, pageSize) as Array<Record<string, unknown>>;
      if (!rows.length) return;
      yield rows.map(rowEdge);
      after = String(rows[rows.length - 1]!.id);
    }
  }

  incomingEdges(toId: string, limit = 100, kind?: GraphEdge["kind"]): GraphEdge[] {
    const rows = kind
      ? this.database.prepare("SELECT * FROM edges WHERE to_id = ? AND kind = ? ORDER BY id LIMIT ?").all(toId, kind, limit)
      : this.database.prepare("SELECT * FROM edges WHERE to_id = ? ORDER BY id LIMIT ?").all(toId, limit);
    return rows.map(rowEdge);
  }

  outgoingEdges(fromId: string, limit = 100): GraphEdge[] {
    return this.database.prepare("SELECT * FROM edges WHERE from_id = ? ORDER BY id LIMIT ?").all(fromId, limit).map(rowEdge);
  }


  node(id: string): GraphNode | undefined {
    const row = this.database.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    return row ? rowNode(row) : undefined;
  }

  findByName(name: string, limit = 50): GraphNode[] {
    return this.database.prepare("SELECT * FROM nodes WHERE name = ? OR qualified_name = ? ORDER BY exported DESC, file_path LIMIT ?").all(name, name, limit).map(rowNode);
  }

  publicSurface(filePaths?: Iterable<string>): PublicSurfaceEntry[] {
    type SurfaceRow = {
      id: string;
      file_path: string;
      qualified_name: string;
      kind: PublicSurfaceEntry["kind"];
      signature: string | null;
    };
    const rows = filePaths
      ? [...filePaths].flatMap((filePath) => this.database
          .prepare("SELECT id, file_path, qualified_name, kind, signature FROM nodes WHERE exported = 1 AND file_path = ? ORDER BY qualified_name")
          .all(filePath) as SurfaceRow[])
      : this.database
          .prepare("SELECT id, file_path, qualified_name, kind, signature FROM nodes WHERE exported = 1 ORDER BY file_path, qualified_name")
          .all() as SurfaceRow[];
    return rows.map((row) => ({
      id: String(row.id),
      filePath: String(row.file_path),
      qualifiedName: String(row.qualified_name),
      kind: row.kind,
      signature: row.signature === null ? undefined : String(row.signature),
    }));
  }

  clones(bodyHash: string, kind: GraphNode["kind"], limit = 6): GraphNode[] {
    return this.database.prepare("SELECT * FROM nodes WHERE body_hash = ? AND kind = ? ORDER BY file_path, start LIMIT ?").all(bodyHash, kind, limit).map(rowNode);
  }

  cloneCount(bodyHash: string, kind: GraphNode["kind"]): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE body_hash = ? AND kind = ?").get(bodyHash, kind) as { count: number | bigint };
    return Number(row.count);
  }

  impact(symbolId: string, maxDepth = 3): ImpactResult {
    const incoming = this.incomingEdges(symbolId);
    const outgoing = this.outgoingEdges(symbolId);
    const impacted = new Set<string>();
    let frontier = [symbolId];
    for (let depth = 0; depth < maxDepth && frontier.length && impacted.size < 10_000; depth += 1) {
      const next: string[] = [];
      for (const target of frontier) {
        for (const edge of this.incomingEdges(target, 10_000 - impacted.size)) {
          if (impacted.has(edge.fromId)) continue;
          impacted.add(edge.fromId);
          next.push(edge.fromId);
        }
        if (impacted.size >= 10_000) break;
      }
      frontier = next;
    }
    return { symbolId, incoming, outgoing, impactedNodeIds: [...impacted] };
  }

  statistics(): { files: number; nodes: number; edges: number } {
    const count = (table: string): number => Number((this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as any).count);
    return { files: count("files"), nodes: count("nodes"), edges: count("edges") };
  }

  private migrate(): void {
    const version = Number((this.database.prepare("PRAGMA user_version").get() as any).user_version);
    if (version > 2) throw new Error(`graph database schema ${version} is newer than supported schema 2`);
    if (version === 2) return;
    if (version === 1) {
      this.database.exec("ALTER TABLE files ADD COLUMN content_hash TEXT; PRAGMA user_version=2;");
      return;
    }
    this.database.exec(`
      CREATE TABLE files(
        path TEXT PRIMARY KEY,
        source_hash TEXT NOT NULL,
        content_hash TEXT,
        language TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE nodes(
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        qualified_name TEXT NOT NULL,
        start INTEGER NOT NULL,
        end INTEGER NOT NULL,
        exported INTEGER NOT NULL,
        signature TEXT,
        body_hash TEXT,
        metadata TEXT NOT NULL,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE TABLE edges(
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        confidence TEXT NOT NULL,
        metadata TEXT NOT NULL,
        FOREIGN KEY(file_path) REFERENCES files(path) ON DELETE CASCADE
      );
      CREATE INDEX nodes_file_idx ON nodes(file_path);
      CREATE INDEX nodes_name_idx ON nodes(name);
      CREATE INDEX nodes_body_idx ON nodes(body_hash);
      CREATE INDEX edges_from_idx ON edges(from_id);
      CREATE INDEX edges_to_idx ON edges(to_id);
      PRAGMA user_version=2;
    `);
  }
}
