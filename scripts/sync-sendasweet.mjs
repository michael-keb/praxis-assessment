#!/usr/bin/env node
/**
 * Vendor the Send a Sweet build into this repo so Docker / Render ship it.
 *
 * In the Send a Sweet source project, export for this site's path first:
 *   cd "../Send a Sweet/Send A Sweet" && node scripts/export-praxis.mjs /send-a-sweet
 * then run this script. `send-a-sweet/public` is committed — Render builds from
 * the repo and never sees the source project.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sweets = path.join(repo, "..", "Send a Sweet");
const build = path.join(sweets, "Send A Sweet", "out-send-a-sweet");
const router = path.join(sweets, "sendasweet-live", "server", "sendasweet.js");
const dest = path.join(repo, "send-a-sweet");

for (const source of [build, router]) {
  if (!fs.existsSync(source)) {
    console.error(`Missing ${source} — run the /send-a-sweet export first.`);
    process.exit(1);
  }
}

const notJunk = (src) => !src.includes(".DS_Store");
fs.rmSync(path.join(dest, "public"), { recursive: true, force: true });
fs.mkdirSync(path.join(dest, "server"), { recursive: true });
fs.cpSync(build, path.join(dest, "public"), { recursive: true, filter: notJunk });
fs.copyFileSync(router, path.join(dest, "server", "sendasweet.js"));
console.log(`Synced ${build} → ${path.join(dest, "public")}`);
