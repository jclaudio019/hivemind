#!/usr/bin/env node
// Build first. Uses only the existing local API and already-running daemon.
import { loadRoutedConfig } from '../dist/src/dir-config.js';
import { DeeplakeApi } from '../dist/src/deeplake-api.js';
import { isLocalMode } from '../dist/src/storage/local-mode.js';
import { embeddingsStatus } from '../dist/src/embeddings/disable.js';
import { EmbedClient } from '../dist/src/embeddings/client.js';
import { backfillSummaryEmbeddings } from '../dist/src/embeddings/backfill.js';
if (!isLocalMode()) throw new Error('Local mode required');
if (embeddingsStatus() !== 'enabled') throw new Error('Existing local embeddings must be enabled');
const cfg = loadRoutedConfig();
if (!cfg) throw new Error('No local config');
const api = new DeeplakeApi(cfg.token,cfg.apiUrl,cfg.orgId,cfg.workspaceId,cfg.tableName);
const client = new EmbedClient({autoSpawn:false});
const args = process.argv.slice(2);
const project = args.find(arg => !arg.startsWith("--"));
const limitArg = args.find(arg => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.slice(8)) : 25;
console.log(JSON.stringify({project:project ?? null,receipt:await backfillSummaryEmbeddings(api,cfg.tableName,t=>client.embed(t,'document'),{project,limit})},null,2));
