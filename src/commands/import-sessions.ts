import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";
import { DeeplakeApi } from "../deeplake-api.js";
import { loadRoutedConfig } from "../dir-config.js";
import { redactSecrets } from "../hooks/shared/redact.js";
import { sqlStr } from "../utils/sql.js";
import { isLocalMode } from "../storage/local-mode.js";

export interface ImportedEvent {
  id: string;
  session_id: string;
  type: "user_message" | "assistant_message" | "tool_call" | "tool_result" | "event";
  content: string;
  timestamp: string;
  source_agent: string;
  source_file: string;
  raw: Record<string, unknown>;
}

export function normalizeImportedLine(line: string, sessionId: string, sourceAgent: string, sourceFile: string, ordinal: number): ImportedEvent | null {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const message = raw.message && typeof raw.message === "object" ? raw.message as Record<string, unknown>
    : raw.payload && typeof raw.payload === "object" ? raw.payload as Record<string, unknown> : raw;
  const kind = String(message.type ?? raw.type ?? "");
  const role = String(message.role ?? raw.role ?? (kind === "user_message" ? "user" : kind === "agent_message" ? "assistant" : "")).toLowerCase();
  const tool = message.tool_name ?? raw.tool_name ?? message.tool ?? raw.tool ?? (kind === "function_call" || kind === "tool_call" ? true : undefined);
  const type: ImportedEvent["type"] = kind === "function_call_output" || kind === "tool_result" ? "tool_result"
    : tool || role === "tool" ? "tool_call" : role === "user" || role === "human" ? "user_message" : role === "assistant" ? "assistant_message" : "event";
  const value = message.content ?? message.text ?? message.message ?? message.output ?? message.arguments ?? raw.content ?? raw.text ?? raw.message ?? raw.output ?? "";
  const content = typeof value === "string" ? value : Array.isArray(value)
    ? value.map(block => block && typeof block === "object" && typeof block.text === "string" ? block.text : JSON.stringify(block)).join("\n")
    : JSON.stringify(value);
  const timestamp = String(raw.timestamp ?? raw.created_at ?? raw.ts ?? message.timestamp ?? "");
  const id = createHash("sha256").update(`${sourceFile}\0${ordinal}\0${line}`).digest("hex").slice(0, 32);
  return { id, session_id: sessionId, type, content, timestamp, source_agent: sourceAgent, source_file: sourceFile, raw };
}

export async function importSessionFiles(files: string[], sourceAgent = "unknown"): Promise<{ files: number; events: number }> {
  if (!isLocalMode()) throw new Error("Historical import is local-only; enable local mode first.");
  const config = loadRoutedConfig();
  if (!config) throw new Error("Local Hivemind configuration could not be loaded.");
  const api = new DeeplakeApi(config.token, config.apiUrl, config.orgId, config.workspaceId, config.sessionsTableName);
  await api.ensureSessionsTable(config.sessionsTableName);
  await api.query(`DELETE FROM "${config.sessionsTableName}" WHERE rowid NOT IN (SELECT MIN(rowid) FROM "${config.sessionsTableName}" GROUP BY id)`);
  await api.query(`CREATE UNIQUE INDEX IF NOT EXISTS "${config.sessionsTableName}_id_unique" ON "${config.sessionsTableName}" (id)`);
  let importedFiles = 0; let events = 0;
  for (const file of files) {
    const fileName = basename(file);
    const sessionId = fileName === "events.jsonl"
      ? basename(dirname(file))
      : fileName.replace(/\.(jsonl?|ndjson|txt)$/i, "") || `import-${Date.now()}`;
    let ordinal = 0;
    const pending: string[] = [];
    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      await api.query(`INSERT OR IGNORE INTO "${config.sessionsTableName}" (id, path, filename, message, author, mime_type, size_bytes, project, description, agent, creation_date, last_update_date) VALUES ${pending.join(",")}`);
      pending.length = 0;
    };
    const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of input) {
      if (!line) continue;
      const safeLine = redactSecrets(line);
      const event = normalizeImportedLine(safeLine, sessionId, sourceAgent, file, ordinal++);
      if (!event) continue;
      const path = `/sessions/${config.userName}/${sessionId}.jsonl`;
      // Historical content can contain Deeplake SQL syntax; hex keeps the local
      // SQL compatibility rewriter from interpreting text inside the payload.
      const message = `CAST(X'${Buffer.from(JSON.stringify(event)).toString("hex")}' AS TEXT)`;
      pending.push(`('${event.id}', '${sqlStr(path)}', '${sqlStr(sessionId + ".jsonl")}', ${message}, '${sqlStr(config.userName)}', 'application/json', ${Buffer.byteLength(line)}, '', '${sqlStr(sourceAgent)}', '${sqlStr(sourceAgent)}', '${sqlStr(event.timestamp)}', '${sqlStr(event.timestamp)}')`);
      events++;
      if (pending.length >= 250) await flush();
    }
    await flush();
    importedFiles++;
  }
  return { files: importedFiles, events };
}

export async function runImportCommand(args: string[]): Promise<void> {
  const agentIndex = args.indexOf("--agent");
  const sourceAgent = agentIndex >= 0 ? args[agentIndex + 1] ?? "unknown" : "unknown";
  const files = args.filter((arg, i) => !arg.startsWith("--") && !(agentIndex >= 0 && i === agentIndex + 1));
  if (!files.length) throw new Error("Usage: hivemind import <file.jsonl> [files...] [--agent hermes|codex|cursor|prime]");
  const result = await importSessionFiles(files, sourceAgent);
  console.log(`Processed ${result.events} event(s) from ${result.files} file(s) into local Hivemind (already-present events are not inserted again).`);
}
