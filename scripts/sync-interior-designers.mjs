#!/usr/bin/env node
/**
 * Copy the Upwork interior-designer shortlist page into static/interior-designers/
 * for deployment on Praxis at /interior-designers
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);
const DEFAULT_SRC =
  "/Users/mk/Documents/Apps/Chrome Extensions/Chrome_assessment_miner/recruitment-manager/data/upwork-applicants/2095961518096053621";
const SRC = process.env.INTERIOR_DESIGNERS_SRC || DEFAULT_SRC;
const DEST = path.join(REPO, "static", "interior-designers");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

const selector = path.join(SRC, "portfolio-selector.html");
const work = path.join(SRC, "portfolio-work");
if (!fs.existsSync(selector)) {
  console.error("Missing portfolio-selector.html:", selector);
  process.exit(1);
}
if (!fs.existsSync(work)) {
  console.error("Missing portfolio-work:", work);
  process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.copyFileSync(selector, path.join(DEST, "index.html"));
copyDir(work, path.join(DEST, "portfolio-work"));

const files = [];
function count(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) count(p);
    else files.push(p);
  }
}
count(DEST);
const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(`Synced ${files.length} files (${(bytes / 1e6).toFixed(1)} MB) → ${DEST}`);
