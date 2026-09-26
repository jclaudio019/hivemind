import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "hivemind-shared-skills-"));
vi.mock("node:os", async (original) => ({ ...(await original()), homedir: () => home }));

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("syncSharedSkill", () => {
  it("publishes and links a learned skill to every local agent", async () => {
    const source = join(home, "source", "SKILL.md");
    mkdirSync(join(home, "source"), { recursive: true });
    writeFileSync(source, "---\nname: learned-one\n---\n\n# Learned\n");
    const { syncSharedSkill } = await import("../../src/commands/shared-skills.js");

    const result = syncSharedSkill({ name: "learned-one", path: source });

    expect(result.linked).toBe(4);
    const shared = join(home, ".local-hivemind", "skills", "learned-one", "SKILL.md");
    expect(readFileSync(shared, "utf8")).toContain("# Learned");
    for (const root of [".codex/skills", ".cursor/skills", ".hermes/skills", ".prime/agent/skills"]) {
      expect(existsSync(join(home, root, "learned-one"))).toBe(true);
    }
  });
});