import { describe, expect, it, afterEach } from "vitest";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBackend } from "../../src/storage/local-backend.js";
import { DeeplakeApi } from "../../src/deeplake-api.js";
import { searchDeeplakeTables } from "../../src/shell/grep-core.js";

describe("LocalBackend", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  it("creates SQLite tables from Hivemind schema SQL and executes parameter-free SQL", async () => {
    const root = mkdtempSync(join(tmpdir(), "hivemind-local-")); roots.push(root);
    const backend = new LocalBackend(root);
    await backend.query(`CREATE TABLE IF NOT EXISTS "sessions" (id TEXT NOT NULL DEFAULT '', message JSONB, message_embedding FLOAT4[]) USING deeplake`);
    await backend.query(`INSERT INTO "sessions" (id, message) VALUES ('s1', E'{"type":"user_message"}')`);
    await expect(backend.query(`SELECT id, message FROM "sessions" WHERE id = 's1'`)).resolves.toEqual([
      { id: "s1", message: '{"type":"user_message"}' },
    ]);
    backend.close();
  });

  it("provides Deeplake-style information_schema columns locally", async () => {
    const root = mkdtempSync(join(tmpdir(), "hivemind-local-")); roots.push(root);
    const backend = new LocalBackend(root);
    await backend.query(`CREATE TABLE IF NOT EXISTS "memory" (id TEXT, summary TEXT)`);
    await expect(backend.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'memory' AND table_schema = 'default'`))
      .resolves.toEqual([{ column_name: "id" }, { column_name: "summary" }]);
    backend.close();
  });

  it("supports Hivemind vector literals and cosine ordering", async () => {
    const root = mkdtempSync(join(tmpdir(), "hivemind-local-")); roots.push(root);
    const backend = new LocalBackend(root);
    await backend.query(`CREATE TABLE "memory" (path TEXT, summary_embedding FLOAT4[])`);
    await backend.query(`INSERT INTO "memory" (path, summary_embedding) VALUES ('/a', ARRAY[1,0]::float4[]), ('/b', ARRAY[0,1]::float4[])`);
    const rows = await backend.query(`SELECT path, (summary_embedding <#> ARRAY[0.9,0.1]::float4[]) AS score FROM "memory" WHERE ARRAY_LENGTH(summary_embedding, 1) > 0 ORDER BY score DESC`);
    expect(rows[0].path).toBe("/a");
    expect(Number(rows[0].score)).toBeGreaterThan(Number(rows[1].score));
    backend.close();
  });

  it("runs Hivemind lexical search over memory and sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "hivemind-local-")); roots.push(root);
    process.env.HIVEMIND_BACKEND = "local";
    process.env.HIVEMIND_LOCAL_ROOT = root;
    const api = new DeeplakeApi("local", "local", "local", "default", "memory");
    await api.query(`CREATE TABLE "memory" (path TEXT, summary TEXT)`);
    await api.query(`CREATE TABLE "sessions" (path TEXT, message TEXT, creation_date TEXT)`);
    await api.query(`INSERT INTO "memory" (path, summary) VALUES ('/summaries/a.md', 'SQLite architecture')`);
    await api.query(`INSERT INTO "sessions" (path, message, creation_date) VALUES ('/sessions/a.jsonl', 'SQLite event', '2026')`);
    const rows = await searchDeeplakeTables(api, "memory", "sessions", { pathFilter: "", contentScanOnly: false, likeOp: "LIKE", escapedPattern: "%SQLite%" });
    expect(rows.map(row => row.path)).toEqual(expect.arrayContaining(["/summaries/a.md", "/sessions/a.jsonl"]));
    delete process.env.HIVEMIND_BACKEND;
    delete process.env.HIVEMIND_LOCAL_ROOT;
    api["local"]?.close?.();
  });

  it("preserves each source limit in local UNION searches", async () => {
    const root = mkdtempSync(join(tmpdir(), "hivemind-local-")); roots.push(root);
    process.env.HIVEMIND_BACKEND = "local";
    process.env.HIVEMIND_LOCAL_ROOT = root;
    const api = new DeeplakeApi("local", "local", "local", "default", "memory");
    await api.query(`CREATE TABLE "memory" (path TEXT, summary TEXT)`);
    await api.query(`CREATE TABLE "sessions" (path TEXT, message TEXT, creation_date TEXT)`);
    for (let i = 0; i < 3; i++) {
      await api.query(`INSERT INTO "memory" (path, summary) VALUES ('/summaries/${i}.md', 'needle')`);
      await api.query(`INSERT INTO "sessions" (path, message, creation_date) VALUES ('/sessions/${i}.jsonl', 'needle', '2026')`);
    }
    const rows = await searchDeeplakeTables(api, "memory", "sessions", {
      pathFilter: "", contentScanOnly: false, likeOp: "LIKE", escapedPattern: "needle", limit: 1,
    });
    expect(rows).toHaveLength(2);
    delete process.env.HIVEMIND_BACKEND;
    delete process.env.HIVEMIND_LOCAL_ROOT;
    api["local"]?.close?.();
  });

  it("shares committed rows across backend instances and restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "hivemind-local-")); roots.push(root);
    const first = new LocalBackend(root);
    await first.query(`CREATE TABLE "memory" (path TEXT, summary TEXT)`);
    await first.query(`INSERT INTO "memory" (path, summary) VALUES ('/shared.md', 'shared instruction')`);
    first.close();

    const second = new LocalBackend(root);
    await expect(second.query(`SELECT summary FROM "memory" WHERE path = '/shared.md'`)).resolves.toEqual([
      { summary: "shared instruction" },
    ]);
    second.close();
  });
});
