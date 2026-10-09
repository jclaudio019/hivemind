/**
 * Hivemind MCP server — exposes shared org memory as MCP tools.
 *
 * Tools:
 *   hivemind_search       — keyword/regex search across summaries + sessions
 *   hivemind_docs_search  — hybrid semantic/lexical search over per-file code docs
 *   hivemind_read         — read full content of a specific memory path
 *   hivemind_index        — list summaries with their dates and descriptions
 *   hivemind_save_summary — save an explicit, local-only ChatGPT checkpoint
 *
 * Transport: stdio. Spawned as a subprocess by the consuming MCP client
 * (Hermes today; reused by any future MCP-aware agent).
 *
 * Cloud reads use ~/.deeplake/credentials.json; local mode needs no cloud
 * credentials, and summary writes are refused outside local mode.
 */

import * as z from "zod/v3";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCredentials } from "../commands/auth.js";
import { loadRoutedConfig } from "../dir-config.js";
import { DeeplakeApi } from "../deeplake-api.js";
import { isMissingTableError } from "../deeplake-schema.js";
import { sqlStr, sqlLike, sqlIdent } from "../utils/sql.js";
import { searchDeeplakeTables, memorySearchFilter, serializeFloat4Array, searchDocs, buildGrepSearchOptions, normalizeContent, TRUNCATION_NOTICE, type GrepMatchParams } from "../shell/grep-core.js";
import { deriveProjectKey } from "../utils/repo-identity.js";
import { embedSummaryWithWarmup } from "../embeddings/embed-summary.js";
import { embeddingsDisabled } from "../embeddings/disable.js";
import { makeQueryEmbedder } from "../docs/embed.js";
import { getVersion } from "../cli/version.js";
import { startCoworkIngestLoop, coworkDataNoticeOnce } from "./cowork-ingest.js";
import { isLocalMode } from "../storage/local-mode.js";

interface ServerContext {
  api: DeeplakeApi;
  memoryTable: string;
  sessionsTable: string;
  docsTable: string;
  userName: string;
}

function getContext(): ServerContext | { error: string } {
  const creds = loadCredentials();
  if (!isLocalMode() && !creds?.token) {
    return { error: "Not authenticated. Run `hivemind login` to sign in to Deeplake." };
  }
  const config = loadRoutedConfig();
  if (!config) {
    return { error: "Hivemind config could not be loaded — credentials present but invalid." };
  }
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.tableName);
  return { api, memoryTable: config.tableName, sessionsTable: config.sessionsTableName, docsTable: config.docsTableName, userName: config.userName };
}

function errorResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

/**
 * Successful tool result. Prepends the one-time Cowork data notice when
 * running inside a Cowork host (no-op everywhere else and after first use).
 */
function okResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: coworkDataNoticeOnce() + text }] };
}

/**
 * On a fresh org no session has run yet, so the memory/sessions tables
 * don't exist — provisioning happens in the per-agent SessionStart hooks,
 * not here (a cloud READ-role member couldn't CREATE TABLE anyway; the
 * summary-save tool provisions the local memory table). Treat the backend's missing-table 400 as "memory
 * is empty" instead of surfacing the raw error (issue #252).
 */
const FRESH_ORG_HINT =
  "Hivemind memory is empty — tables are created when the first agent session starts, and entries appear after it ends.";

const server = new McpServer({
  name: "hivemind",
  version: getVersion(),
});

server.registerTool(
  "hivemind_search",
  {
    description: "Search Hivemind shared memory (summaries + raw sessions) by keyword or multi-word phrase. Returns matching paths and snippets. Use this first when the user asks about prior work, conversations, or context that may exist in Hivemind. Different paths under /summaries/<username>/ are different users — do not merge them.",
    inputSchema: {
      query: z.string().min(1).describe("Literal phrase in exact mode; natural-language concept in hybrid mode."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum total hits to return (default 10)."),
      project: z.string().min(1).optional().describe("Exact stored project name; no implicit cwd or legacy project rows."),
      path_prefix: z.string().startsWith("/").optional().describe("Literal memory path prefix; /sessions/ explicitly includes raw tool events."),
      mode: z.enum(["exact", "hybrid"]).optional().describe("Default exact; hybrid adds local embedding similarity and reports coverage or lexical fallback."),
    },
  },
  async ({ query, limit, mode = "exact", project, path_prefix }: { query: string; limit?: number; mode?: "exact" | "hybrid"; project?: string; path_prefix?: string }) => {
    const ctx = getContext();
    if ("error" in ctx) return errorResult(ctx.error);

    const params: GrepMatchParams = {
      pattern: query,
      ignoreCase: true,
      wordMatch: false,
      filesOnly: false,
      countOnly: false,
      lineNumber: false,
      invertMatch: false,
      fixedString: true,
    };
    const opts = buildGrepSearchOptions(params, "/");
    opts.limit = limit ?? 10;
    opts.project = project;
    opts.pathPrefix = path_prefix;
    opts.retrievalHistory = !path_prefix?.startsWith("/sessions/");
    // MCP exact search promises a literal phrase, not grep's broad word union.
    opts.multiWordPatterns = undefined;

    let notice = "";
    try {
      if (mode === "hybrid") {
        opts.queryEmbedding = await makeQueryEmbedder()(query) ?? undefined;
        if (!opts.queryEmbedding?.length) {
          notice = "[hivemind: hybrid unavailable — query embeddings unavailable; exact lexical fallback.]\n\n";
        } else {
          const coverage = await Promise.all([
            [ctx.memoryTable, "summary_embedding"], [ctx.sessionsTable, "message_embedding"],
          ].map(async ([table, column]) => {
            const rows = await ctx.api.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN ARRAY_LENGTH(${column}, 1) > 0 THEN 1 ELSE 0 END) AS embedded FROM "${sqlIdent(table)}" WHERE 1=1${memorySearchFilter(opts, table === ctx.sessionsTable)}`);
            return { total: Number(rows[0]?.total ?? 0), embedded: Number(rows[0]?.embedded ?? 0) };
          }));
          const total = coverage.reduce((n, c) => n + c.total, 0);
          const embedded = coverage.reduce((n, c) => n + c.embedded, 0);
          notice = `[hivemind: hybrid embedding coverage ${embedded}/${total} rows${embedded ? "; unembedded rows remain lexical-only" : "; exact lexical fallback"}.]\n\n`;
          if (!embedded) opts.queryEmbedding = undefined;
        }
      }
      const meta = { truncated: false };
      const rows = await searchDeeplakeTables(ctx.api, ctx.memoryTable, ctx.sessionsTable, opts, meta);
      if (rows.length === 0) return errorResult(`${notice}No matches for "${query}".`);
      if (rows.length > opts.limit) meta.truncated = true;
      const lines = rows.slice(0, opts.limit).map(r => {
        const body = normalizeContent(r.path, r.content);
        const match = body.toLowerCase().indexOf(query.toLowerCase());
        const start = Math.max(0, match - 200);
        return `[${r.path}]\n${start ? "…" : ""}${body.slice(start, start + 600)}${body.length > start + 600 ? "…" : ""}`;
      });
      // Tell the caller when the row cap was hit so it doesn't treat a capped
      // page as the complete set (consistent with the grep path).
      if (meta.truncated) lines.push(TRUNCATION_NOTICE);
      return okResult(notice + lines.join("\n\n---\n\n"));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isMissingTableError(msg)) return errorResult(`No matches for "${query}". ${FRESH_ORG_HINT}`);
      return errorResult(`Search failed: ${msg}`);
    }
  },
);

server.registerTool(
  "hivemind_docs_search",
  {
    description: "Search the per-file CODE documentation (kept fresh on commits) by meaning or keyword. Hybrid semantic + lexical. Use for 'where is X handled / how does Y work / which file does Z' about the current codebase — returns the most relevant source files with a one-line summary. Different from hivemind_search (that's past sessions/conversations; this is code docs).",
    inputSchema: {
      query: z.string().describe("Natural-language question or keywords about the codebase."),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum docs to return (default 10)."),
    },
  },
  async ({ query, limit }: { query: string; limit?: number }) => {
    const ctx = getContext();
    if ("error" in ctx) return errorResult(ctx.error);

    const params: GrepMatchParams = {
      pattern: query, ignoreCase: true, wordMatch: false, filesOnly: false,
      countOnly: false, lineNumber: false, invertMatch: false, fixedString: true,
    };
    const opts = buildGrepSearchOptions(params, "/");
    opts.limit = limit ?? 10;
    // Scope to the server's repo (legacy '' rows stay visible) — a shared org
    // table must not leak another repo's docs into this one's search.
    opts.project = deriveProjectKey(process.cwd()).key;
    // Same rail as memory search: semantic when embeddings are on, else lexical.
    opts.queryEmbedding = await makeQueryEmbedder()(query);

    try {
      const rows = await searchDocs((sql) => ctx.api.query(sql), ctx.docsTable, opts);
      if (rows.length === 0) return errorResult(`No docs match "${query}".`);
      const lines = rows.map(r => `[${r.path}]\n${r.content.slice(0, 600)}`);
      return { content: [{ type: "text", text: lines.join("\n\n---\n\n") }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isMissingTableError(msg)) return errorResult(`No docs match "${query}". ${FRESH_ORG_HINT}`);
      return errorResult(`Docs search failed: ${msg}`);
    }
  },
);

server.registerTool(
  "hivemind_read",
  {
    description: "Read the full content of a specific Hivemind memory path. Use after hivemind_search to drill into a hit, or when you already know the path (e.g. /summaries/alice/abc.md or /sessions/alice/alice_org_ws_xyz.jsonl or /index.md).",
    inputSchema: {
      path: z.string().describe("Absolute Hivemind memory path, e.g. /summaries/alice/abc.md"),
    },
  },
  async ({ path }: { path: string }) => {
    const ctx = getContext();
    if ("error" in ctx) return errorResult(ctx.error);

    if (!path.startsWith("/")) {
      return errorResult(`Path must start with '/': got "${path}"`);
    }

    const isSession = path.startsWith("/sessions/");
    const table = isSession ? ctx.sessionsTable : ctx.memoryTable;
    const column = isSession ? "message::text" : "summary::text";

    try {
      const sql = `SELECT path, ${column} AS content FROM "${table}" WHERE path = '${sqlStr(path)}' LIMIT 200`;
      const rows = await ctx.api.query(sql);
      if (rows.length === 0) return errorResult(`No content found at ${path}.`);
      const text = rows.map(r => normalizeContent(String(r["path"]), String(r["content"] ?? ""))).join("\n");
      return okResult(text);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isMissingTableError(msg)) return errorResult(`No content found at ${path}. ${FRESH_ORG_HINT}`);
      return errorResult(`Read failed: ${msg}`);
    }
  },
);

server.registerTool(
  "hivemind_index",
  {
    description: "List Hivemind summary entries (one row per session). Use to see what's in shared memory and find relevant sessions to drill into with hivemind_read.",
    inputSchema: {
      prefix: z.string().optional().describe("Path prefix to filter by, e.g. '/summaries/alice/' to scope to one user."),
      limit: z.number().int().min(1).max(200).optional().describe("Maximum rows (default 50)."),
    },
  },
  async ({ prefix, limit }: { prefix?: string; limit?: number }) => {
    const ctx = getContext();
    if ("error" in ctx) return errorResult(ctx.error);

    // sqlLike escapes both quotes AND LIKE wildcards (% / _) so an
    // LLM-supplied prefix can't bypass the filter (e.g. prefix='%' would
    // match every row otherwise). ESCAPE '\\' tells the engine to honour
    // the backslash escapes sqlLike inserts.
    const where = prefix
      ? `WHERE path LIKE '${sqlLike(prefix)}%' ESCAPE '\\'`
      : `WHERE path LIKE '/summaries/%'`;
    const sql = `SELECT path, description, project, last_update_date FROM "${ctx.memoryTable}" ${where} ORDER BY last_update_date DESC LIMIT ${limit ?? 50}`;

    try {
      const rows = await ctx.api.query(sql);
      if (rows.length === 0) return errorResult("No summaries found.");
      const lines = rows.map(r => {
        const path = String(r["path"] ?? "?");
        const desc = String(r["description"] ?? "");
        const project = String(r["project"] ?? "");
        const date = String(r["last_update_date"] ?? "");
        return `${path}\t${date}\t${project}\t${desc}`;
      });
      return okResult(`path\tlast_updated\tproject\tdescription\n${lines.join("\n")}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isMissingTableError(msg)) return errorResult(`No summaries found. ${FRESH_ORG_HINT}`);
      return errorResult(`Index failed: ${msg}`);
    }
  },
);

server.registerTool(
  "hivemind_save_summary",
  {
    description: "Save a concise ChatGPT conversation checkpoint to local Hivemind only. Reuse session_id for later checkpoints from the same chat; send a compact summary, not the full transcript.",
    inputSchema: {
      summary: z.string().min(1).max(100_000).describe("Compact Markdown checkpoint."),
      session_id: z.string().min(1).max(120).optional().describe("Stable conversation ID; reuse it for later checkpoints."),
      project: z.string().max(200).optional().describe("Project or repository label."),
    },
  },
  async ({ summary, session_id, project }: { summary: string; session_id?: string; project?: string }) => {
    if (!isLocalMode()) return errorResult("Saving summaries is disabled unless Hivemind local mode is enabled.");
    if (!summary.trim()) return errorResult("Summary must not be empty.");
    const ctx = getContext();
    if ("error" in ctx) return errorResult(ctx.error);

    const safeSessionId = session_id ?? randomUUID();
    if (!/^[A-Za-z0-9_-]+$/.test(safeSessionId)) {
      return errorResult("session_id may contain only letters, numbers, underscores, and hyphens.");
    }
    const authorPath = ctx.userName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "local";
    const timestamp = new Date().toISOString();
    const filename = `${safeSessionId}-${timestamp.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.md`;
    const path = `/summaries/${authorPath}/chatgpt/${filename}`;
    const description = summary.split("\n").map(line => line.trim().replace(/^#+\s*/, "")).find(Boolean)?.slice(0, 160) ?? "ChatGPT checkpoint";

    try {
      await ctx.api.ensureTable();
      const embedding = embeddingsDisabled() ? null : await embedSummaryWithWarmup(summary, "document");
      const embeddingSql = embedding?.length ? serializeFloat4Array(embedding) : "NULL";
      await ctx.api.query(
        `INSERT INTO "${sqlIdent(ctx.memoryTable)}" (id, path, filename, summary, summary_embedding, author, mime_type, size_bytes, project, description, agent, plugin_version, creation_date, last_update_date) VALUES ('${randomUUID()}', '${sqlStr(path)}', '${sqlStr(filename)}', '${sqlStr(summary)}', ${embeddingSql}, '${sqlStr(ctx.userName)}', 'text/markdown', ${Buffer.byteLength(summary, "utf8")}, '${sqlStr(project ?? "")}', '${sqlStr(description)}', 'chatgpt', '${sqlStr(getVersion())}', '${sqlStr(timestamp)}', '${sqlStr(timestamp)}')`,
      );
      return okResult(`Saved local Hivemind checkpoint at ${path}.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult(`Summary save failed: ${msg}`);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Cowork has no capture hooks — tail its local transcripts and write them
  // to the sessions table so Cowork conversations become shared memory too.
  // Best-effort and self-throttling; never touches the stdio channel.
  startCoworkIngestLoop();
}

main().catch((err) => {
  process.stderr.write(`hivemind-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
