import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { importSessionFiles, normalizeImportedLine } from "../../src/commands/import-sessions.js";
import { redactSecrets } from "../../src/hooks/shared/redact.js";

describe("historical session normalization", () => {
  it("normalizes Claude/Codex-style role records while preserving provenance", () => {
    const event = normalizeImportedLine(
      JSON.stringify({ timestamp: "2026-01-02T03:04:05Z", role: "user", content: "fix auth" }),
      "session-1", "codex", "/archive/session-1.jsonl", 0,
    );
    expect(event).toMatchObject({ session_id: "session-1", type: "user_message", content: "fix auth", source_agent: "codex", source_file: "/archive/session-1.jsonl", timestamp: "2026-01-02T03:04:05Z" });
    expect(event?.id).toHaveLength(32);
  });

  it("normalizes tool records and skips malformed lines", () => {
    expect(normalizeImportedLine('{"tool_name":"terminal","content":{"exit":0}}', "s", "prime", "f", 1)?.type).toBe("tool_call");
    expect(normalizeImportedLine("not-json", "s", "prime", "f", 2)).toBeNull();
  });

  it("redacts secrets before storing imported content", () => {
    const event = normalizeImportedLine(
      JSON.stringify({ role: "user", content: "password=plainvalue" }),
      "session-secret", "junie", "/archive/session.jsonl", 0,
    );
    expect(redactSecrets(event?.content ?? "")).toBe("password=********");
  });

  it("imports payloads containing Deeplake SQL syntax as plain text", async () => {
    const root = mkdtempSync(join(tmpdir(), "hivemind-import-"));
    const file = join(root, "history.jsonl");
    const content = "ARRAY[1,2]::float4[] and a quote: it's text";
    writeFileSync(file, `${JSON.stringify({ role: "user", content })}\n`);
    process.env.HIVEMIND_BACKEND = "local";
    process.env.HIVEMIND_LOCAL_ROOT = root;
    try {
      await importSessionFiles([file], "hermes");
      const db = new DatabaseSync(join(root, "hivemind.db"));
      const row = db.prepare("SELECT message FROM sessions").get() as { message: string };
      expect(JSON.parse(row.message).content).toBe(content);
      db.close();
    } finally {
      delete process.env.HIVEMIND_BACKEND;
      delete process.env.HIVEMIND_LOCAL_ROOT;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
