import { isLocalMode } from '../storage/local-mode.js';
import { sqlIdent, sqlStr } from '../utils/sql.js';
import { serializeFloat4Array } from '../shell/grep-core.js';
import type { DocEmbedder } from '../docs/embed.js';

/** Local caller supplies the existing API. Successful rows leave the missing
 * set; rerunning resumes failures. Guard content against concurrent summaries. */
export async function backfillSummaryEmbeddings(
  api: { query(sql: string): Promise<Record<string, unknown>[]> },
  table: string,
  embed: DocEmbedder,
  options: { limit?: number; project?: string } = {},
): Promise<Array<{ id: string; path: string; embedded: boolean }>> {
  if (!isLocalMode()) throw new Error('Summary backfill is local-only');
  const limit = Math.max(1, Math.min(25, Math.floor(options.limit ?? 25)));
  if (!Number.isFinite(limit)) throw new Error('Invalid backfill limit');
  const name = sqlIdent(table);
  const missing = `(summary_embedding IS NULL OR summary_embedding = ARRAY[]::float4[])`;
  const scope = options.project !== undefined ? ` AND project = '${sqlStr(options.project)}'` : '';
  const rows = await api.query(`SELECT id, path, summary::text AS summary FROM "${name}" WHERE ${missing} AND path LIKE '/summaries/%'${scope} ORDER BY last_update_date DESC, id LIMIT ${limit}`);
  const receipt: Array<{id: string; path: string; embedded: boolean}> = [];
  for (const row of rows) {
    const id = String(row.id); const path = String(row.path); const text = String(row.summary ?? '');
    const vector = text.trim() ? await embed(text) : null;
    if (!vector?.length || vector.some(v => !Number.isFinite(v))) {
      receipt.push({id, path, embedded:false});
      continue;
    }
    await api.query(`UPDATE "${name}" SET summary_embedding = ${serializeFloat4Array(vector)} WHERE id = '${sqlStr(id)}' AND path = '${sqlStr(path)}' AND summary::text = CAST(X'${Buffer.from(text).toString('hex')}' AS TEXT) AND ${missing}`);
    const readback = await api.query(`SELECT id, path, CASE WHEN ARRAY_LENGTH(summary_embedding, 1) > 0 THEN 1 ELSE 0 END AS embedded FROM "${name}" WHERE id = '${sqlStr(id)}' AND path = '${sqlStr(path)}'`);
    receipt.push({id, path, embedded: Number(readback[0]?.embedded) === 1});
  }
  return receipt;
}
