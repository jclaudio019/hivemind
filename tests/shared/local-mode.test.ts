import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("persisted local mode", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("enables and disables local mode through the marker without an env var", async () => {
    const home = mkdtempSync(join(tmpdir(), "hivemind-local-mode-"));
    homes.push(home);
    vi.stubEnv("HOME", home);
    delete process.env.HIVEMIND_BACKEND;
    vi.resetModules();

    const mode = await import("../../src/storage/local-mode.js");
    expect(mode.isLocalMode()).toBe(false);
    mode.enableLocalMode();
    expect(mode.isLocalMode()).toBe(true);
    mode.disableLocalMode();
    expect(mode.isLocalMode()).toBe(false);
  });
});
