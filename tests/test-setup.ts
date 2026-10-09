// Global vitest setup. Runs once before any test file.
//
// Why: as of the embeddings-config refactor, `~/.deeplake/config.json` is the
// source of truth for `embeddings.enabled`. The migration helper in
// src/user-config.ts writes to that file on first read if no key is present.
// Without isolation, every test run would mutate the developer's real config.
// This setup pins `HIVEMIND_CONFIG_PATH` to a per-process tmp dir so all
// reads / writes land in throwaway state.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const tmpDir = mkdtempSync(join(tmpdir(), "hivemind-test-config-"));
process.env.HIVEMIND_CONFIG_PATH = join(tmpDir, "config.json");
// Isolate backend selection and subprocesses from the user's enabled marker/DB.
process.env.HOME = tmpDir;
process.env.USERPROFILE = tmpDir;
process.env.HIVEMIND_LOCAL_ROOT = join(tmpDir, ".local-hivemind");
delete process.env.HIVEMIND_BACKEND;

// Default to embeddings-enabled in the test env so existing tests that
// expect the embed code path to run aren't surprised by the new
// opt-in-required default. Tests that exercise the disabled path set their
// own values via _setEnabledReaderForTesting or by writing the config file
// directly.
process.env.HIVEMIND_EMBEDDINGS = "true";

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});
