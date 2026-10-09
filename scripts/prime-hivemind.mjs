#!/usr/bin/env node
process.env.HIVEMIND_BACKEND ??= "local";
process.env.HIVEMIND_LOCAL_ROOT ??= `${process.env.HOME}/.local-hivemind`;
/** Run Prime Agent in JSON mode and import its emitted events locally. */
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  let imported = false;
  try {
    writeFileSync(file, text, { mode: 0o600 });
    const receipt = execFileSync(process.execPath, [fileURLToPath(new URL("../bundle/cli.js", import.meta.url)), "import", file, "--agent", "prime"], { env: process.env, encoding: "utf8", timeout: 60_000 });
    imported = true;
    console.error(`prime-hivemind: ${receipt.trim()}`);
  } catch (error) {
    console.error(`prime-hivemind: local capture failed: ${error instanceof Error ? error.message : String(error)}; events preserved at ${file}`);
    if (code === 0) process.exitCode = 1;
  } finally {
    if (imported) rmSync(dir, { recursive: true, force: true });
  }
  if (code !== null && code !== 0) process.exitCode = code;
});
