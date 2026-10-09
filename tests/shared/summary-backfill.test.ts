import { it, expect, vi, beforeEach, afterEach } from 'vitest';
beforeEach(() => vi.stubEnv('HIVEMIND_BACKEND', 'local'));
afterEach(() => vi.unstubAllEnvs());
import { backfillSummaryEmbeddings } from '../../src/embeddings/backfill.js';
it('caps at 25, never selects raw events, retries missing rows on resume and reads successful IDs back', async () => {
  const query = vi.fn().mockResolvedValueOnce([{id:'a',path:'/summaries/a.md',summary:'real'}]).mockResolvedValueOnce([]).mockResolvedValueOnce([{id:'a',path:'/summaries/a.md',embedded:1}]);
  const embed = vi.fn().mockResolvedValue([1,0]);
  const result = await backfillSummaryEmbeddings({query}, 'memory', embed, {limit:100,project:'veronica-os'});
  expect(query.mock.calls[0][0]).toContain('LIMIT 25');
  expect(query.mock.calls[0][0]).toContain("project = 'veronica-os'");
  expect(query.mock.calls[0][0]).not.toContain('sessions');
  expect(query.mock.calls[1][0]).toContain("summary::text = CAST(X'7265616c' AS TEXT)");
  expect(result).toEqual([{id:'a',path:'/summaries/a.md',embedded:true}]);
});
it('does not write when embedding unavailable', async () => {
  const query = vi.fn().mockResolvedValue([{id:'a',path:'/summaries/a.md',summary:'real'}]);
  expect(await backfillSummaryEmbeddings({query}, 'memory', async()=>null)).toEqual([{id:'a',path:'/summaries/a.md',embedded:false}]);
  expect(query).toHaveBeenCalledTimes(1);
});
it('guards real local summary text with backslashes without changing originals', async () => {
  const { LocalBackend } = await import('../../src/storage/local-backend.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root=mkdtempSync(join(tmpdir(),'backfill-'));
  const b=new LocalBackend(root);
  try {
    await b.query('CREATE TABLE memory (id TEXT, path TEXT, summary TEXT, summary_embedding FLOAT4[], last_update_date TEXT)');
    const text=String.raw`real history with \command and 'quotes'`;
    await b.query(`INSERT INTO memory VALUES ('a','/summaries/a.md',CAST(X'${Buffer.from(text).toString('hex')}' AS TEXT),NULL,'2026')`);
    expect(await backfillSummaryEmbeddings(b,'memory',async()=>[1,0])).toEqual([{id:'a',path:'/summaries/a.md',embedded:true}]);
    expect((await b.query('SELECT summary FROM memory'))[0].summary).toBe(text);
  } finally {b.close();rmSync(root,{recursive:true,force:true});}
});
