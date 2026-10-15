#!/usr/bin/env node
/**
 * Download all submitted assessment sessions from production as zip files.
 *
 * Usage:
 *   node scripts/download-all-assessments.mjs
 *   node scripts/download-all-assessments.mjs --out ./downloads/2026-09-07
 *
 * Reads ADMIN_EMAIL / ADMIN_PASSWORD from .env in the project root.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = "https://assessments.praxis-au.com";

function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) throw new Error("Missing .env — need ADMIN_EMAIL and ADMIN_PASSWORD");
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq);
    let val = trimmed.slice(eq + 1);
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

function parseArgs() {
  const outIdx = process.argv.indexOf("--out");
  const outDir =
    outIdx >= 0 && process.argv[outIdx + 1]
      ? path.resolve(process.argv[outIdx + 1])
      : path.join(ROOT, "downloads", new Date().toISOString().slice(0, 10));
  const dryRun = process.argv.includes("--dry-run");
  return { outDir, dryRun };
}

function isDownloadable(code) {
  return code.status === "submitted" || (code.frames || 0) > 0 || (code.audio || 0) > 0;
}

function safeName(code) {
  const name = (code.candidate_name || "unknown").replace(/[^\w\s.-]/g, "").trim().replace(/\s+/g, " ");
  return `${name || "unknown"} - ${code.code}`;
}

function jobFolder(assessmentTitle) {
  const title = String(assessmentTitle || "").trim();
  return title || "unknown";
}

function destForCode(outDir, code) {
  const job = jobFolder(code.assessment_title);
  const filename = `${safeName(code)}.zip`;
  const dir = path.join(outDir, "by-job", job);
  return { dir, dest: path.join(dir, filename), filename, job };
}

async function main() {
  const env = loadEnv();
  const email = env.ADMIN_EMAIL;
  const password = env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");

  const { outDir, dryRun } = parseArgs();
  fs.mkdirSync(outDir, { recursive: true });

  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!loginRes.ok) {
    const body = await loginRes.text();
    throw new Error(`Login failed (${loginRes.status}): ${body}`);
  }
  const cookie = loginRes.headers.getSetCookie?.() || [];
  const sessionCookie = cookie.find((c) => c.startsWith("praxis_session="));
  if (!sessionCookie) throw new Error("Login succeeded but no praxis_session cookie returned");
  const cookieHeader = sessionCookie.split(";")[0];

  const codesRes = await fetch(`${BASE}/api/admin/codes`, {
    headers: { Cookie: cookieHeader },
  });
  if (!codesRes.ok) throw new Error(`Failed to list codes (${codesRes.status})`);
  const { codes } = await codesRes.json();
  const downloadable = codes.filter(isDownloadable);

  console.log(`Found ${codes.length} codes total, ${downloadable.length} with submissions to download`);
  console.log(`Output: ${outDir}${dryRun ? " (dry run)" : ""}\n`);

  const manifest = [];
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const code of downloadable) {
    const { dir, dest, filename, job } = destForCode(outDir, code);
    const relPath = path.join("by-job", job, filename);
    manifest.push({
      code: code.code,
      candidate: code.candidate_name,
      assessment: code.assessment_title,
      status: code.status,
      submitted_at: code.submitted_at,
      frames: code.frames,
      audio: code.audio,
      file: filename,
      folder: path.join("by-job", job),
      path: relPath,
    });

    if (fs.existsSync(dest)) {
      console.log(`skip  ${code.code}  (already exists)`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`would ${code.code}  ${code.candidate_name || "—"}  → ${relPath}`);
      continue;
    }

    fs.mkdirSync(dir, { recursive: true });
    process.stdout.write(`get   ${code.code}  ${code.candidate_name || "—"} ... `);
    try {
      const zipRes = await fetch(`${BASE}/api/admin/sessions/${code.code}/zip`, {
        headers: { Cookie: cookieHeader },
      });
      if (!zipRes.ok) throw new Error(`HTTP ${zipRes.status}`);
      const buf = Buffer.from(await zipRes.arrayBuffer());
      fs.writeFileSync(dest, buf);
      console.log(`${(buf.length / 1024 / 1024).toFixed(1)} MB`);
      downloaded++;
    } catch (err) {
      console.log(`FAILED: ${err.message}`);
      failed++;
    }
  }

  const manifestPath = path.join(outDir, "manifest.json");
  if (!dryRun) {
    fs.writeFileSync(manifestPath, JSON.stringify({ downloadedAt: new Date().toISOString(), codes: manifest }, null, 2));
  }

  console.log(`\nDone: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
  if (!dryRun) console.log(`Manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
