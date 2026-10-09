import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
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
    mkdirSync(join(home, "source", "references"));
    writeFileSync(join(home, "source", "references", "data.md"), "supporting evidence");
    const { syncSharedSkill } = await import("../../src/commands/shared-skills.js");

    const result = syncSharedSkill({ name: "learned-one", path: source });

    expect(result.linked).toBe(4);
    const shared = join(home, ".local-hivemind", "skills", "learned-one", "SKILL.md");
    expect(readFileSync(shared, "utf8")).toContain("# Learned");
    for (const root of [".codex/skills", ".cursor/skills", ".hermes/skills", ".prime/agent/skills"]) {
      expect(existsSync(join(home, root, "learned-one"))).toBe(true);
      expect(readFileSync(join(home, root, "learned-one", "references", "data.md"), "utf8")).toBe("supporting evidence");
    }
  });

  it("replaces child destination symlinks without writing to their targets", async () => {
    const { syncSharedSkill } = await import("../../src/commands/shared-skills.js");
    const destination = join(home, ".local-hivemind", "skills", "safe-child");
    mkdirSync(destination, { recursive: true });
    const victim = join(home, "victim.txt");
    writeFileSync(victim, "original");
    symlinkSync(victim, join(destination, "SKILL.md"));
    syncSharedSkill({ name: "safe-child", path: join(home, "source", "SKILL.md") });
    expect(readFileSync(victim, "utf8")).toBe("original");
    expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toContain("# Learned");
  });

  it("rejects traversal from discovered frontmatter and destination symlinks", async () => {
    const { syncSharedSkills, syncSharedSkill } = await import("../../src/commands/shared-skills.js");
    const bad = join(home, ".hermes", "skills", "invalid");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "SKILL.md"), "---\nname: ../../escaped\n---\n");
    try {
      expect(() => syncSharedSkills()).toThrow(/skill name/i);
      expect(existsSync(join(home, "escaped", "SKILL.md"))).toBe(false);
    } finally { rmSync(bad, { recursive: true, force: true }); }
    const target = join(home, "external-target");
    mkdirSync(target);
    symlinkSync(target, join(home, ".local-hivemind", "skills", "symlink-case"), "dir");
    expect(() => syncSharedSkill({ name: "symlink-case", path: join(home, "source", "SKILL.md") })).toThrow(/symlink/i);
    expect(existsSync(join(target, "SKILL.md"))).toBe(false);
  });

  it.each(["../../escaped", "/absolute", "..", "bad\\name"])("refuses unsafe skill name %s before writing", async name => {
    const { syncSharedSkill } = await import("../../src/commands/shared-skills.js");
    expect(() => syncSharedSkill({ name, path: join(home, "source", "SKILL.md") })).toThrow(/skill name/i);
    expect(existsSync(join(home, "escaped", "SKILL.md"))).toBe(false);
  });
});