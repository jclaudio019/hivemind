import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

export const SHARED_SKILLS_ROOT = join(homedir(), ".local-hivemind", "skills");

interface SkillSource {
  name: string;
  path: string;
}

function skillName(path: string): string {
  const body = readFileSync(path, "utf8");
  const match = body.match(/^name:\s*([^\n]+)$/m);
  return (match?.[1] ?? path.split("/").at(-2) ?? "skill").trim().replace(/^['"]|['"]$/g, "");
}

function findSkills(root: string): SkillSource[] {
  const out: SkillSource[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name === "SKILL.md") out.push({ name: skillName(path), path });
    }
  }
  if (existsSync(root)) walk(root);
  return out;
}

function safeLink(link: string, target: string): boolean {
  if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) return false;
  mkdirSync(join(link, ".."), { recursive: true });
  symlinkSync(target, link, "dir");
  return true;
}

export interface SharedSkillsSyncResult {
  imported: number;
  linked: number;
  skipped: number;
  root: string;
}

/** Publish one learned skill to the local cross-agent skill directory. */
export function syncSharedSkill(source: SkillSource): SharedSkillsSyncResult {
  const agentRoots = [
    join(homedir(), ".codex", "skills"),
    join(homedir(), ".cursor", "skills"),
    join(homedir(), ".hermes", "skills"),
    join(homedir(), ".prime", "agent", "skills"),
  ];
  const sharedDir = join(SHARED_SKILLS_ROOT, source.name);
  mkdirSync(sharedDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(sharedDir, "SKILL.md"), readFileSync(source.path));
  let linked = 0;
  let skipped = 0;
  for (const root of agentRoots) {
    if (safeLink(join(root, source.name), sharedDir)) linked++;
    else skipped++;
  }
  return { imported: 1, linked, skipped, root: SHARED_SKILLS_ROOT };
}

export function syncSharedSkills(): SharedSkillsSyncResult {
  const hermesRoot = join(homedir(), ".hermes", "skills");
  const agentRoots = [
    join(homedir(), ".codex", "skills"),
    join(homedir(), ".cursor", "skills"),
    hermesRoot,
    join(homedir(), ".prime", "agent", "skills"),
  ];
  mkdirSync(SHARED_SKILLS_ROOT, { recursive: true, mode: 0o700 });

  let imported = 0;
  let linked = 0;
  let skipped = 0;
  const sources = findSkills(hermesRoot);
  const names = new Set<string>();
  for (const source of sources) {
    let name = source.name || "skill";
    if (names.has(name)) {
      const suffix = relative(hermesRoot, source.path).replaceAll("/", "--").replace(/--SKILL\.md$/, "");
      name = `${name}--${suffix}`;
    }
    names.add(name);
    const sharedDir = join(SHARED_SKILLS_ROOT, name);
    const sharedFile = join(sharedDir, "SKILL.md");
    if (!existsSync(sharedFile)) {
      mkdirSync(sharedDir, { recursive: true });
      writeFileSync(sharedFile, readFileSync(source.path));
      imported++;
    }
    for (const root of agentRoots) {
      if (root === hermesRoot && source.path.startsWith(`${hermesRoot}/`)) continue;
      const link = join(root, name);
      if (safeLink(link, sharedDir)) linked++;
      else skipped++;
    }
  }
  writeFileSync(join(SHARED_SKILLS_ROOT, "INDEX.md"),
    [...names].sort().map(name => `- ${name}: ${join(SHARED_SKILLS_ROOT, name, "SKILL.md")}`).join("\n") + "\n");
  return { imported, linked, skipped, root: SHARED_SKILLS_ROOT };
}
