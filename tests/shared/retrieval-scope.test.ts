import { describe, it, expect } from "vitest";
import { LocalBackend } from "../../src/storage/local-backend.js";
import { searchDeeplakeTables, memorySearchFilter } from "../../src/shell/grep-core.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sqlStr } from "../../src/utils/sql.js";

describe("MCP retrieval scope before candidate caps", () => {
  it.each([undefined, [1, 0]])("filters projects, prefixes and tool echoes before lexical/vector limits: %s", async (queryEmbedding) => {
    const root = mkdtempSync(join(tmpdir(), "retrieval-scope-"));
    const b = new LocalBackend(root);
    try {
      await b.query('CREATE TABLE memory (path TEXT, project TEXT, summary TEXT, summary_embedding FLOAT4[])');
      await b.query('CREATE TABLE sessions (path TEXT, project TEXT, message TEXT, message_embedding FLOAT4[], creation_date TEXT)');
      for (const project of ['', 'other', 'veronica-os']) {
        await b.query(`INSERT INTO memory VALUES ('/summaries/${project || 'legacy'}/a.md','${project}','needle',ARRAY[1,0]::float4[])`);
      }
      for (const type of ['tool_call', 'event', 'user_message', 'assistant_message']) {
        await b.query(`INSERT INTO sessions VALUES ('/sessions/${type}.jsonl','veronica-os','${sqlStr(JSON.stringify({type,raw:type==='event'?{payload:{type:'function_call_output',output:'needle'}}:undefined,content:'needle with {\"type\":\"tool_call\"} quoted in real history',tool_response:'needle'}))}',ARRAY[1,0]::float4[],'2026')`);
      }
      await b.query("INSERT INTO memory VALUES ('/summaries/veronica-os/literal.md','veronica-os','record_worker_actual_model',ARRAY[1,0]::float4[])");
      const literal = await searchDeeplakeTables(b as any, 'memory', 'sessions', {pathFilter:'',contentScanOnly:false,likeOp:'ILIKE',retrievalHistory:true,escapedPattern:'record\\_worker\\_actual\\_model',limit:1});
      expect(literal[0]?.path).toBe('/summaries/veronica-os/literal.md');
      const opts = { pathFilter: '', contentScanOnly: false, likeOp: 'ILIKE' as const, escapedPattern: 'needle', limit: 1, project: 'veronica-os', retrievalHistory: true, queryEmbedding };
      const hits = await searchDeeplakeTables(b as any, 'memory', 'sessions', opts);
      expect(hits.some(h => h.path.includes('legacy') || h.path.includes('/other/') || h.path.includes('tool_call') || h.path.includes('/event.jsonl'))).toBe(false);
      expect(hits[0].path).toBe('/summaries/veronica-os/a.md');
      const raw = await searchDeeplakeTables(b as any, 'memory', 'sessions', {...opts, pathFilter: " AND path LIKE '/sessions/%'", retrievalHistory: false});
      expect(raw[0].path).toContain('tool_call');
      expect(await b.query("SELECT COUNT(*) AS n FROM sessions")).toEqual([{n:4}]);
      const prefixed = await searchDeeplakeTables(b as any, 'memory', 'sessions', {...opts, pathPrefix:'/summaries/other/'});
      expect(prefixed).toEqual([]);
      const literalPrefix = await searchDeeplakeTables(b as any, 'memory', 'sessions', {...opts, pathPrefix:'/summaries/veronica_os%/'});
      expect(literalPrefix).toEqual([]);
      expect(memorySearchFilter({...opts, pathPrefix:'/summaries/veronica_os%/'}, false)).toContain("veronica\\_os\\%");
    } finally { b.close(); rmSync(root, {recursive:true,force:true}); }
  });
});
