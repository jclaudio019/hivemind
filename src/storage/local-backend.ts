import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_ROOT } from "./local-mode.js";

/**
 * SQLite execution seam for the existing Hivemind SQL callers.
 *
 * It intentionally accepts the small Deeplake/Postgres SQL dialect emitted by
 * this repository and translates only storage-specific syntax at the boundary.
 * Higher layers keep their table schemas and query shapes.
 */
export class LocalBackend {
  private readonly db: DatabaseSync;

  constructor(readonly root: string = process.env.HIVEMIND_LOCAL_ROOT ?? LOCAL_ROOT) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of ["sessions", "summaries", "skills", "memory", "embeddings", "codegraph", "repos"]) {
      mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(join(root, "hivemind.db"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 10000;");
    this.db.function("hivemind_cosine", (left: unknown, right: unknown) => cosine(left, right));
  }

  async query(sql: string): Promise<Record<string, unknown>[]> {
    const union = this.runSearchUnion(sql);
    if (union) return union;
    const normalized = normalizeSql(sql);
    const info = informationSchemaQuery(normalized);
    if (info) return this.columns(info.table);
    if (/^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|PRAGMA)\b/i.test(normalized)) {
      const statement = this.db.prepare(normalized);
      statement.run();
      return [];
    }
    return this.db.prepare(normalized).all() as Record<string, unknown>[];
  }

  listTables(): string[] {
    return (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>).map(row => row.name);
  }

  close(): void { this.db.close(); }

  private columns(table: string): Record<string, unknown>[] {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return [];
    return this.db.prepare(`PRAGMA table_info("${table}")`).all()
      .map((row: any) => ({ column_name: row.name }));
  }

  private runSearchUnion(sql: string): Record<string, unknown>[] | null {
    const from = sql.indexOf(" FROM (");
    const end = sql.lastIndexOf(") AS combined");
    if (from < 0 || end < from || !/^\s*SELECT\s+path,\s+content,/i.test(sql)) return null;
    const inner = sql.slice(from + 7, end);
    const parts = inner.split(/\)\s+UNION\s+ALL\s+\(/i).map(part => part.replace(/^\s*\(/, "").replace(/\)\s*$/, ""));
    if (parts.length < 2 || parts.some(part => !/^\s*SELECT\b/i.test(part))) return null;
    const rows = parts.flatMap(part => this.db.prepare(normalizeSql(part)).all() as Record<string, unknown>[]);
    const order = sql.match(/ORDER BY\s+(.+?)(?:\s+LIMIT\s+(\d+))?\s*$/i);
    if (order) {
      const keys = order[1].split(",").map(key => key.trim().split(/\s+/));
      rows.sort((a, b) => {
        for (const [key, direction] of keys) {
          const av = String(a[key] ?? ""); const bv = String(b[key] ?? "");
          if (av === bv) continue;
          const result = av < bv ? -1 : 1;
          return direction?.toUpperCase() === "DESC" ? -result : result;
        }
        return 0;
      });
      return order[2] ? rows.slice(0, Number(order[2])) : rows;
    }
    return rows;
  }
}

function informationSchemaQuery(sql: string): { table: string } | null {
  const match = sql.match(/FROM\s+information_schema\.columns\s+WHERE\s+table_name\s*=\s*'((?:''|[^'])*)'/i);
  return match ? { table: match[1].replace(/''/g, "'") } : null;
}

function normalizeSql(sql: string): string {
  let normalized = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'") {
      if (inString && sql[i + 1] === "'") {
        normalized += "''";
        i++;
        continue;
      }
      inString = !inString;
    }
    if (!inString && (char === "E" || char === "e") && sql[i + 1] === "'") {
      normalized += "'";
      i++;
    } else {
      normalized += char;
    }
  }
  return normalized
    // PostgreSQL escape-string literals are ordinary SQLite string literals for
    // our already-escaped payloads. Backslash decoding is deliberately omitted.
    .replace(/\s+USING\s+deeplake_index\s*(?=\()/gi, "")
    .replace(/\s+USING\s+deeplake\s*;?\s*$/i, "")
    .replace(/::text\b/gi, "")
    .replace(/::jsonb\b/gi, "")
    .replace(/\bILIKE\b/gi, "LIKE")
    .replace(/ARRAY_LENGTH\(([_a-zA-Z][a-zA-Z0-9_]*)\s*,\s*1\)\s*>\s*0/gi, "$1 IS NOT NULL AND $1 <> '[]'")
    .replace(/([_a-zA-Z][a-zA-Z0-9_]*)\s+<#>\s+ARRAY\[([^\]]*)\]::float4\[\]/gi, (_m, col, vector) =>
      `hivemind_cosine(${col}, '[${vector}]')`)
    .replace(/ARRAY\[([^\]]*)\]::float4\[\]/gi, (_m, vector) => `'[${vector}]'`)
    .replace(/::float4\[\]/gi, "")
    .replace(/LIMIT\s+\d+\s*\)(\s+UNION(?:\s+ALL)?\s+)/gi, "$1")
    .replace(/LIMIT\s+\d+\s*\)(\s*\))/gi, "$1")
    .replace(/\((\s*SELECT\b[\s\S]*?)\)(\s+UNION(?:\s+ALL)?\s+)\((\s*SELECT\b[\s\S]*?)\)/gi, "$1$2$3")
    .replace(/\bJSONB\b/gi, "TEXT")
    .replace(/\bFLOAT4\[\]/gi, "TEXT");
}
function cosine(left: unknown, right: unknown): number {
  try {
    const a = typeof left === "string" ? JSON.parse(left) : left;
    const b = typeof right === "string" ? JSON.parse(right) : right;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
    let dot = 0; let aa = 0; let bb = 0;
    for (let i = 0; i < a.length; i++) {
      const x = Number(a[i]); const y = Number(b[i]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
      dot += x * y; aa += x * x; bb += y * y;
    }
    return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
  } catch { return 0; }
}
