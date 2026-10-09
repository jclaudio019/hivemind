import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBackend } from '../../src/storage/local-backend.js';
import { sqlStr, sqlLike } from '../../src/utils/sql.js';
import { searchDeeplakeTables } from '../../src/shell/grep-core.js';
import { normalizeImportedLine } from '../../src/commands/import-sessions.js';
import { resolveWorkspaceOverride } from '../../src/commands/auth.js';
import { autoUpdate } from '../../src/hooks/shared/autoupdate.js';
import { DeeplakeApi } from '../../src/deeplake-api.js';

let root: string;
let backend: LocalBackend;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-regression-'));
  vi.stubEnv('HIVEMIND_BACKEND', 'local');
  vi.stubEnv('HIVEMIND_LOCAL_ROOT', root);
  backend = new LocalBackend(root);
});
afterEach(() => { backend.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(root, { recursive:true, force:true }); });

it('round-trips summary text through the real sqlStr writer boundary', async () => {
  const text = String.raw`C:\Users\name and \d+ plus 'quotes' and ILIKE ::text`;
  await backend.query('CREATE TABLE memory (summary TEXT)');
  await backend.query(`INSERT INTO memory VALUES ('${sqlStr(text)}')`);
  expect(await backend.query('SELECT summary FROM memory')).toEqual([{summary:text}]);
});

it('treats UNION delimiters inside a search phrase as literal text', async () => {
  await backend.query('CREATE TABLE memory (path TEXT, summary TEXT)');
  await backend.query('CREATE TABLE sessions (path TEXT, message TEXT, creation_date TEXT)');
  const phrase = ') UNION ALL (';
  await backend.query(`INSERT INTO memory VALUES ('/summaries/test.md','${sqlStr(phrase)}')`);
  const rows = await searchDeeplakeTables(backend as any,'memory','sessions',{pathFilter:'',contentScanOnly:false,likeOp:'LIKE',escapedPattern:sqlLike(phrase)});
  expect(rows.map(r=>r.content)).toEqual([phrase]);
});

it('blocks cloud workspace lookup and upstream self-update in local mode', async () => {
  const fetch = vi.fn(() => { throw new Error('unexpected cloud request'); });
  vi.stubGlobal('fetch', fetch);
  vi.stubEnv('HIVEMIND_WORKSPACE_ID','nondefault');
  const creds={token:'cloud-token',orgId:'cloud-org',apiUrl:'https://example.invalid',savedAt:'2026-01-01'};
  expect(await resolveWorkspaceOverride(creds)).toEqual({creds});
  const spawn = vi.fn(()=>({pid:1}));
  await autoUpdate(creds,{agent:'hermes',hivemindBinaryPath:'/fake/hivemind',spawn});
  expect(fetch).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

it('discovers known local tables without making HTTP requests', async () => {
  const fetch = vi.fn(() => Promise.reject(new Error('cloud forbidden')));
  vi.stubGlobal('fetch', fetch);
  const api = new DeeplakeApi('local', 'local', 'local', 'named-workspace', 'memory');
  try {
    await api.query('CREATE TABLE known_table (id TEXT)');
    expect(await api.knownTablesOrNull()).toContain('known_table');
    expect(fetch).not.toHaveBeenCalled();
  } finally { api['local']?.close(); }
});

it('normalizes native Codex response_item envelopes and preserves raw provenance', () => {
  const raw={type:'response_item',timestamp:'2026-01-01',payload:{type:'message',role:'user',content:[{type:'input_text',text:'fix the UI'}]}};
  expect(normalizeImportedLine(JSON.stringify(raw),'s','codex','f',0)).toMatchObject({type:'user_message',content:'fix the UI',raw});
});
