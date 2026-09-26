#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const sessionsRoot = resolve(process.env.JUNIE_SESSIONS_ROOT ?? join(homedir(), ".junie", "sessions"));
const pycharmRoot = resolve(process.env.PYCHARM_ROOT ?? join(homedir(), "Library", "Application Support", "JetBrains"));
const stagingRoot = resolve(process.env.HIVEMIND_STAGING_ROOT ?? join(homedir(), ".local-hivemind", "import-staging", "pycharm"));
const cli = resolve(process.env.HIVEMIND_CLI ?? join(import.meta.dirname, "..", "bundle", "cli.js"));
const env = { ...process.env, HIVEMIND_BACKEND: "local", HIVEMIND_LOCAL_ROOT: process.env.HIVEMIND_LOCAL_ROOT ?? join(homedir(), ".local-hivemind") };
const once = process.argv.includes("--once");
let timer;
let running = false;
let pending = false;

function filesUnder(root, predicate) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path, predicate));
    else if (predicate(path, entry.name)) files.push(path);
  }
  return files;
}

function decodeXml(value) {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function option(block, name) {
  const match = block.match(new RegExp(`<option name="${name}" value="([\\s\\S]*?)"\\s*/>`));
  return match ? decodeXml(match[1]) : "";
}

function stagePycharmChats(xmlFile) {
  const xml = readFileSync(xmlFile, "utf8");
  const component = xml.match(/<component name="ChatSessionStateTemp">([\s\S]*?)<\/component>/)?.[1];
  if (!component) return [];
  mkdirSync(stagingRoot, { recursive: true });
  const staged = [];
  for (const chat of component.matchAll(/<SerializedChat>([\s\S]*?)<\/SerializedChat>/g)) {
    const block = chat[1];
    const uid = option(block, "uid") || createHash("sha256").update(`${xmlFile}:${chat.index}`).digest("hex").slice(0, 16);
    const messages = [];
    for (const message of block.matchAll(/<SerializedChatMessage>([\s\S]*?)<\/SerializedChatMessage>/g)) {
      const messageBlock = message[1];
      const author = option(messageBlock, "author");
      const content = option(messageBlock, "displayContent") || option(messageBlock, "internalContent");
      const attachments = [...messageBlock.matchAll(/<option name="text" value="([\s\S]*?)"\s*\/>/g)]
        .map(match => decodeXml(match[1])).filter(Boolean);
      const fullContent = [content, ...attachments.map(text => `[attachment]\n${text}`)].filter(Boolean).join("\n\n");
      if (fullContent) messages.push({ role: author.toLowerCase() === "assistant" ? "assistant" : "user", content: fullContent });
    }
    if (!messages.length) continue;
    const id = createHash("sha256").update(`${xmlFile}:${uid}`).digest("hex").slice(0, 24);
    const file = join(stagingRoot, `${id}.jsonl`);
    const output = messages.map(message => JSON.stringify(message)).join("\n") + "\n";
    const changed = !existsSync(file) || readFileSync(file, "utf8") !== output;
    if (changed) {
      writeFileSync(file, output);
      staged.push(file);
    }
  }
  return staged;
}

function importFile(file, agent) {
  return new Promise((resolveImport, reject) => {
    execFile(process.execPath, [cli, "import", file, "--agent", agent], { env }, (error, stdout, stderr) => {
      if (stdout.trim()) process.stdout.write(stdout);
      if (stderr.trim()) process.stderr.write(stderr);
      if (error) reject(error); else resolveImport();
    });
  });
}

async function sync() {
  if (running) { pending = true; return; }
  running = true;
  try {
    for (const file of filesUnder(sessionsRoot, (_, name) => name === "events.jsonl")) await importFile(file, "junie");
    for (const xml of filesUnder(pycharmRoot, (_, name) => name.endsWith(".xml"))) {
      for (const file of stagePycharmChats(xml)) await importFile(file, "pycharm-ai");
    }
  } finally {
    running = false;
    if (pending) { pending = false; await sync(); }
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => sync().catch(error => console.error(`junie-hivemind: ${error.message}`)), 250);
}

await sync();
if (!once) {
  for (const root of [sessionsRoot, pycharmRoot]) {
    if (existsSync(root)) watch(root, { recursive: true }, schedule).on("error", error => console.error(`junie-hivemind watcher: ${error.message}`));
  }
  console.error(`junie-hivemind: watching Junie ${sessionsRoot} and PyCharm ${pycharmRoot}`);
}
