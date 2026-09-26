#!/usr/bin/env node
process.env.HIVEMIND_BACKEND ??= "local";
process.env.HIVEMIND_LOCAL_ROOT ??= `${process.env.HOME}/.local-hivemind`;
/** Run Prime Agent in JSON mode and import its emitted events locally. */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const bin = process.env.PRIME_AGENT_BIN ?? "prime-agent";
const hasMode = args.some(arg => arg === "--mode" || arg.startsWith("--mode="));
const child = spawn(bin, hasMode ? args : ["--mode", "json", ...args], { stdio: ["inherit", "pipe", "inherit"], env: process.env });
const chunks = [];
child.stdout.on("data", chunk => { chunks.push(chunk); process.stdout.write(chunk); });
child.on("error", error => { console.error(`prime-hivemind: ${error.message}`); process.exitCode = 1; });
child.on("close", async code => {
  const text = Buffer.concat(chunks).toString("utf8");
  const dir = mkdtempSync(join(tmpdir(), "hivemind-prime-"));
  const file = join(dir, `${randomUUID()}.jsonl`);
  try {
    writeFileSync(file, text);
    const { importSessionFiles } = await import("../dist/src/commands/import-sessions.js");
    const result = await importSessionFiles([file], "prime");
    console.error(`prime-hivemind: imported ${result.events} event(s) locally`);
  } catch (error) {
    console.error(`prime-hivemind: local capture failed: ${error instanceof Error ? error.message : String(error)}`);
    if (code === 0) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (code !== null && code !== 0) process.exitCode = code;
});
