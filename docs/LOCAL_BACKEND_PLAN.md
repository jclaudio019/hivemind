# Local Hivemind Backend

Status: Phase 1 foundation complete; remaining implementation is uncommitted on `main`. See `LOCAL_BACKEND_ROADMAP.md` for the next slices.

## Architecture assessment

Hivemind is a TypeScript client/integration layer. Agent adapters, hooks, local workers, local embedding daemon, Markdown skills, local state, and most orchestration are already local. The Deeplake dependency is concentrated in the SQL client, credential/config assumptions, direct worker fetches, and Deeplake-specific SQL/index/storage behavior.

## Dependency map

| Area | Current implementation | Local disposition |
|---|---|---|
| Claude/Codex/Cursor/Hermes/pi hooks | Local subprocess/hooks | Reuse unchanged where possible |
| Event capture | Hook builds structured rows | Reuse; route persistence through backend |
| Session summaries | Local worker invokes host CLI | Reuse prompt/worker; replace persistence query/write |
| Skillify | Local worker + host LLM CLI | Reuse; local tables/files |
| SkillOpt | Local worker + host LLM CLI | Reuse with local persistence and stronger validation later |
| Embeddings | Local nomic daemon | Reuse unchanged |
| Proactive recall | Hook + query + local embedding | Reuse query logic; local SQL/vector adapter |
| MCP tools | Local stdio process | Reuse tool surface; local backend context |
| Rules/goals | VFS translated to SQL | Reuse translation; local SQL backend |
| Code graph/docs | Local extraction/workers, Deeplake persistence | Replace persistence; keep formats |
| Auth/org/workspace | Deeplake account model | Local identity/config; no token required |
| SQL query client | HTTP POST to Deeplake | Replace with SQLite execution adapter |
| Tables/indexes | Deeplake tables/index syntax | SQLite tables/FTS indexes |
| Cross-machine sync | Deeplake service | Not in local-only mode; explicit export/import later |

## Exact Deeplake dependencies

- Default endpoint: `https://api.deeplake.ai`.
- Bearer token and org/workspace headers.
- `POST /workspaces/{workspace}/tables/query` for SQL.
- `GET /workspaces/{workspace}/tables` for table discovery.
- Deeplake-specific `USING deeplake` table creation.
- Deeplake-specific `deeplake_index` index creation.
- `information_schema.columns` schema introspection.
- Array/vector column syntax (`FLOAT4[]`) and vector operators in retrieval SQL.
- Server-side org/workspace isolation.
- Deeplake SDK dependency in package metadata.
- Auth/device-flow and hosted notification/billing endpoints.

## Local persistence design

Root: `~/.local-hivemind/` (override with `HIVEMIND_LOCAL_ROOT`).

- `hivemind.db`: SQLite database, WAL mode, foreign keys enabled.
- `sessions/`: immutable JSONL mirrors for inspection/export.
- `summaries/`: Markdown summaries.
- `skills/`: canonical local `SKILL.md` files and backups.
- `memory/`: VFS-compatible Markdown material.
- `embeddings/`: local model/cache metadata; vectors are stored in SQLite as JSON for portability.
- `codegraph/`: graph snapshots.
- `repos/`: repository-local metadata and imported artifacts.

Use the existing schema column names where practical to minimize changes. SQLite FTS5 indexes `memory`, `sessions`, and `skills` text. Vectors are initially JSON blobs with cosine ranking in bounded application code; upgrade to sqlite-vec only if measurements justify a dependency.

## Concurrency and durability

- One SQLite connection per API instance/process.
- WAL mode and busy timeout.
- Transactions for writes and versioned skill/rule/goal updates.
- Immutable event rows and skill versions.
- Atomic Markdown writes (`.tmp` then rename).
- Local process locks remain for background workers; SQLite transactions prevent partial rows.
- Export is a SQLite backup plus Markdown/JSONL tree. No network sync is implied.

## Staged plan

1. Local SQLite backend behind `HIVEMIND_BACKEND=local`.
2. Capture/events and lexical retrieval.
3. Local vector persistence and semantic recall through existing embedding daemon.
4. Summary worker local query/write path.
5. Local Skillify and SkillOpt persistence/promotion.
6. MCP and VFS local mode.
7. Rules/goals/docs/graph local stores.
8. Agent adapters and shared skill fan-out.
9. Prime Agent adapter after its actual runtime interface is located.
10. Historical importer with per-agent normalizers.

## Deliberate simplifications

- No Postgres, DuckDB, server, daemon, or Kubernetes.
- No cross-machine synchronization in local mode.
- No model-weight training in the first implementation.
- No vector extension until SQLite JSON vectors prove insufficient.

## Acceptance checks

- Local mode never loads Deeplake credentials or calls the Deeplake host.
- Hermes event capture survives restart.
- Lexical retrieval works without embeddings.
- Local embeddings remain optional and offline after model download.
- Summary/skill workers use the selected local backend.
- Skills remain ordinary `SKILL.md` files.
