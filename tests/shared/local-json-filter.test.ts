import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "../../src/storage/local-backend.js";
import { parseSessionJson } from "../../src/utils/session-json.js";

it("extracts session filter types without parsing entire transcripts into the JS heap", async () => {
  const root = mkdtempSync(join(tmpdir(), "hivemind-json-"));
  const backend = new LocalBackend(root);
  const messages = [
    JSON.stringify({ type: "user_message", content: "Veronica " + "x".repeat(2_000) }),
    JSON.stringify({ type: "event", raw: { payload: { type: "function_call_output" } } }),
    JSON.stringify({ type: "event", raw: { payload: { type: "function_call_output" } }, content: 'quoted "Veronica"' }).replace(/\\/g, "\\\\"),
    JSON.stringify({ type: "assistant_message", content: 'literal \\n and "type":"tool_call"' }),
    '{"type":42,"raw":{"payload":{"type":false}}}',
    '{"type":{"nested":"tool_call"},"raw":{"payload":{"type":[]}}}',
    '{"type":null}', "null", "not JSON", '{"type":"broken',
  ];
  const expected = messages.map((message, id) => {
    const parsed = parseSessionJson(message);
    return { id, event_type: typeof parsed?.type === "string" ? parsed.type : null,
      payload_type: typeof parsed?.raw?.payload?.type === "string" ? parsed.raw.payload.type : null };
  });
  let parse: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await backend.query("CREATE TABLE sessions (id INTEGER, message TEXT)");
    for (const [id, message] of messages.entries()) {
      await backend.query(`INSERT INTO sessions VALUES (${id}, '${message.replace(/'/g, "''")}')`);
    }
    parse = vi.spyOn(JSON, "parse");
    const rows = await backend.query("SELECT id, message ->> 'type' AS event_type, message -> 'raw' -> 'payload' ->> 'type' AS payload_type FROM sessions ORDER BY id");
    expect(rows).toEqual(expected);
    expect(parse).not.toHaveBeenCalled();
    expect(await backend.query("SELECT message FROM sessions WHERE id = 0")).toEqual([{ message: messages[0] }]);
  } finally {
    parse?.mockRestore();
    backend.close();
    rmSync(root, { recursive: true, force: true });
  }
});
