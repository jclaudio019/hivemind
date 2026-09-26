#!/usr/bin/env node
process.env.HIVEMIND_BACKEND = "local";
process.env.HIVEMIND_LOCAL_ROOT ??= `${process.env.HOME}/.local-hivemind`;
await import("../mcp/bundle/server.js");
