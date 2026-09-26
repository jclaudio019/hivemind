# Local Hivemind Roadmap

Repository: `/Users/joseclaudio/Dev_local/hivemind-local`

## Current status

**Phase 1 foundation complete; remaining work is uncommitted on `main`.**

Verified:

- Native SQLite backend with WAL
- `HIVEMIND_BACKEND=local`
- Hermes capture
- Lexical and cosine retrieval
- Local wiki-worker query routing
- Rules and goals CLI
- MCP server over stdio
- Prime MCP consumer registration
- Prime JSON capture wrapper
- Historical JSONL importer
- Local code graph build
- Typecheck, production build, focused tests, restart persistence, concurrent writes

## Next implementation order

1. Add local-mode end-to-end tests for summary generation and Skillify.
2. Add held-out adversarial regression scoring before SkillOpt promotion.
3. Verify local VFS reads/writes for memory, rules, goals, and skills.
4. Audit every runtime Deeplake fetch and hard-disable it in local mode.
5. Add local Markdown mirrors for sessions, summaries, and skill versions.
6. Verify repository documentation/wiki persistence locally.
7. Add a persistent local-mode launcher/config path for GUI-launched agents.
8. Import Hermes/Codex/Cursor/Claude archives when available.
9. Exercise Prime wrapper with the real Prime JSON event stream.
10. Run focused local integration tests, then triage upstream baseline failures.
11. Commit the implementation after the local acceptance matrix is green.

## Local commands

```bash
cd /Users/joseclaudio/Dev_local/hivemind-local
npm install
npm run build

export HIVEMIND_BACKEND=local
export HIVEMIND_LOCAL_ROOT="$HOME/.local-hivemind"

# Install/refresh Hermes integration
HOME=/Users/joseclaudio node bundle/cli.js hermes install

# Import Prime history
HOME=/Users/joseclaudio node bundle/cli.js import \
  /Users/joseclaudio/.prime/agent/sessions/*.jsonl \
  --agent prime

# Run focused tests
npm test -- --run tests/shared/local-backend.test.ts tests/shared/import-sessions.test.ts
npm run typecheck
```

## Important boundaries

- Do not modify Lumina or treat this as Lumina's authoritative memory system.
- Local mode stores memory locally; the model provider used by an agent may still be remote.
- No Deeplake account, paid storage, Postgres, DuckDB, Kubernetes, or sync service is required.
- Prime source was not available locally; integration is wrapper + MCP, not a Prime fork.
