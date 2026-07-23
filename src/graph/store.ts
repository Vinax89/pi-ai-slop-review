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
    this.database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  updateFile(facts: GraphFileFacts): boolean {
    const current = this.database.prepare("SELECT source_hash FROM files WHERE path = ?").get(facts.filePath) as any;
    if (current?.source_hash === facts.sourceHash) return false;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM edges WHERE file_path = ?").run(facts.filePath);
      this.database.prepare("DELETE FROM nodes WHERE file_path = ?").run(facts.filePath);
      this.database
        .prepare("INSERT INTO files(path, source_hash, language, updated_at) VALUES(?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET source_hash=excluded.source_hash, language=excluded.language, updated_at=excluded.updated_at")
        .run(facts.filePath, facts.sourceHash, facts.language, new Date().toISOString());
      const insertNode = this.database.prepare(
        "INSERT OR REPLACE INTO nodes(id, file_path, kind, name, qualified_name, start, end, exported, signature, body_hash, metadata) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
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
      const insertEdge = this.database.prepare(
        "INSERT OR REPLACE INTO edges(id, file_path, from_id, to_id, kind, confidence, metadata) VALUES(?, ?, ?, ?, ?, ?, ?)",
      );
      for (const edge of facts.edges) {
        insertEdge.run(edge.id, edge.filePath, edge.fromId, edge.toId, edge.kind, edge.confidence, JSON.stringify(edge.metadata));
      }
      this.database.exec("COMMIT");
      return true;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeFiles(paths: string[]): void {
    if (!paths.length) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const deleteEdges = this.database.prepare("DELETE FROM edges WHERE file_path = ?");
      const deleteNodes = this.database.prepare("DELETE FROM nodes WHERE file_path = ?");
      const deleteFile = this.database.prepare("DELETE FROM files WHERE path = ?");
      for (const filePath of paths) {
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

  nodes(filePath?: string): GraphNode[] {
    const rows = filePath
      ? this.database.prepare("SELECT * FROM nodes WHERE file_path = ? ORDER BY start, id").all(filePath)
      : this.database.prepare("SELECT * FROM nodes ORDER BY file_path, start, id").all();
    return rows.map(rowNode);
  }

  edges(filePath?: string): GraphEdge[] {
    const rows = filePath
      ? this.database.prepare("SELECT * FROM edges WHERE file_path = ? ORDER BY id").all(filePath)
      : this.database.prepare("SELECT * FROM edges ORDER BY file_path, id").all();
    return rows.map(rowEdge);
  }

  node(id: string): GraphNode | undefined {
    const row = this.database.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    return row ? rowNode(row) : undefined;
  }

  findByName(name: string): GraphNode[] {
    return this.database.prepare("SELECT * FROM nodes WHERE name = ? OR qualified_name = ? ORDER BY exported DESC, file_path").all(name, name).map(rowNode);
  }

  publicSurface(): PublicSurfaceEntry[] {
    return this.database
      .prepare("SELECT id, file_path, qualified_name, kind, signature FROM nodes WHERE exported = 1 ORDER BY file_path, qualified_name")
      .all()
      .map((row: any) => ({
        id: String(row.id),
        filePath: String(row.file_path),
        qualifiedName: String(row.qualified_name),
        kind: row.kind,
        signature: row.signature === null ? undefined : String(row.signature),
      }));
  }

  clones(bodyHash: string): GraphNode[] {
    return this.database.prepare("SELECT * FROM nodes WHERE body_hash = ? ORDER BY file_path, start").all(bodyHash).map(rowNode);
  }

  impact(symbolId: string, maxDepth = 3): ImpactResult {
    const allEdges = this.edges();
    const incoming = allEdges.filter((edge) => edge.toId === symbolId);
    const outgoing = allEdges.filter((edge) => edge.fromId === symbolId);
    const impacted = new Set<string>();
    let frontier = [symbolId];
    for (let depth = 0; depth < maxDepth && frontier.length; depth += 1) {
      const next: string[] = [];
      for (const target of frontier) {
        for (const edge of allEdges) {
          if (edge.toId !== target || impacted.has(edge.fromId)) continue;
          impacted.add(edge.fromId);
          next.push(edge.fromId);
        }
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
    if (version > 1) throw new Error(`graph database schema ${version} is newer than supported schema 1`);
    if (version === 1) return;
    this.database.exec(`
      CREATE TABLE files(
        path TEXT PRIMARY KEY,
        source_hash TEXT NOT NULL,
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
      PRAGMA user_version=1;
    `);
  }
}
