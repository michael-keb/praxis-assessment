#!/usr/bin/env node
/**
 * Diagnose spoken-transcript coverage for production sessions.
 *
 * Usage:
 *   node scripts/voice-diagnose.mjs M5BFVH QB2B4J            # specific codes
 *   node scripts/voice-diagnose.mjs --assessment "Backend"   # every code whose assessment title contains the text
 *   node scripts/voice-diagnose.mjs --file session.json      # an already-downloaded /api/admin/sessions/:code body
 *
 * Reads ADMIN_EMAIL / ADMIN_PASSWORD from .env (same as download-all-assessments.mjs).
 * Prints, per session: how long the tab was hidden, how many spoken words landed
 * while hidden vs visible, every transport event (reconnects, stalls, mic loss),
 * the longest stretch with neither words nor a mic_silent warning, and — for
 * sessions recorded after the audio_health telemetry shipped — whether PCM was
 * actually flowing to AssemblyAI while the tab was hidden.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.PRAXIS_BASE || "https://assessments.praxis-au.com";

function loadEnv() {
  const env = {};
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq < 1 || line.trim().startsWith("#")) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

async function login() {
  const env = loadEnv();
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env");
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed (${res.status})`);
  const cookie = (res.headers.getSetCookie?.() || []).find((c) => c.startsWith("praxis_session="));
  if (!cookie) throw new Error("no praxis_session cookie");
  return { Cookie: cookie.split(";")[0] };
}

const mmss = (t) => `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
const words = (text) => String(text || "").trim().split(/\s+/).filter(Boolean).length;

function analyse(code, body) {
  const payload = body.payload || body.checkpoint || {};
  const log = (payload.log || []).slice().sort((a, b) => (a.t || 0) - (b.t || 0));
  const end = log.length ? Math.max(...log.map((e) => e.t || 0)) : 0;
  const counts = {};
  for (const e of log) counts[e.type] = (counts[e.type] || 0) + 1;

  // Hidden intervals from blur_tab / return_tab pairs.
  const hidden = [];
  let openAt = null;
  for (const e of log) {
    if (e.type === "blur_tab" && openAt == null) openAt = e.t;
    if (e.type === "return_tab" && openAt != null) { hidden.push([openAt, e.t]); openAt = null; }
  }
  if (openAt != null) hidden.push([openAt, end]);
  const hiddenSec = hidden.reduce((s, [a, b]) => s + (b - a), 0);
  const isHidden = (t) => hidden.some(([a, b]) => t >= a && t <= b);

  const voice = log.filter((e) => e.type === "voice");
  const wordsHidden = voice.filter((e) => isHidden(e.t)).reduce((s, e) => s + words(e.text), 0);
  const wordsVisible = voice.reduce((s, e) => s + words(e.text), 0) - wordsHidden;

  // Longest stretch with no words and no mic_silent warning: the engine
  // believed it was hearing partials (lastHeardAt kept moving) yet nothing
  // reached the log — the signature of a logging-path loss, not a quiet mic.
  let worstGap = 0, worstFrom = 0, last = 0;
  const marks = log.filter((e) => e.type === "voice" || e.type === "mic_silent" || e.type === "transcript_started").map((e) => e.t);
  for (const t of [...marks, end]) { if (t - last > worstGap) { worstGap = t - last; worstFrom = last; } last = t; }

  const transport = log.filter((e) => /^(transcript_|audio_|mic_lost|mic_silent|capture_)/.test(e.type));
  const health = log.filter((e) => e.type === "audio_health");
  const healthHidden = health.filter((e) => e.hidden);
  const healthVisible = health.filter((e) => !e.hidden);
  const avg = (rows, key) => rows.length ? Math.round(rows.reduce((s, r) => s + (r[key] ?? 0), 0) / rows.length) : null;

  return {
    code, candidate: body.code?.candidate_name || body.candidate?.name || "", assessment: body.code?.assessment_title || "",
    status: body.code?.status, draft: !body.payload, endSec: end, frames: (body.frames || []).length,
    voiceLines: voice.length, wordsHidden, wordsVisible, hiddenSec, hiddenSpans: hidden.length,
    worstGap, worstFrom, counts, transport, health,
    chunksHidden: avg(healthHidden, "chunks"), chunksVisible: avg(healthVisible, "chunks"),
    levelHidden: avg(healthHidden, "level"), levelVisible: avg(healthVisible, "level"),
    engine: log.find((e) => e.type === "transcript_started")?.audio || log.find((e) => e.type === "transcript_started")?.engine || "?",
  };
}

function print(r) {
  console.log(`\n## ${r.candidate || "?"} — ${r.code}  (${r.assessment}, ${r.status}${r.draft ? ", draft checkpoint" : ""})`);
  console.log(`session ${mmss(r.endSec)} · frames ${r.frames} · voice lines ${r.voiceLines} · engine ${r.engine}`);
  console.log(`tab hidden ${mmss(r.hiddenSec)} across ${r.hiddenSpans} span(s) · words while hidden ${r.wordsHidden} · words while visible ${r.wordsVisible}`);
  console.log(`longest stretch with no words and no mic_silent: ${mmss(r.worstGap)} starting at ${mmss(r.worstFrom)}`);
  if (r.health.length) {
    console.log(`audio_health (per 30s): hidden avg chunks ${r.chunksHidden} level ${r.levelHidden} dB · visible avg chunks ${r.chunksVisible} level ${r.levelVisible} dB`);
  } else {
    console.log("audio_health: none (session predates the telemetry; audio flow while hidden is unknown)");
  }
  const t = r.transport.filter((e) => e.type !== "audio_health");
  if (t.length) console.log("transport events: " + t.map((e) => { const { t: at, type, ...rest } = e; return `${mmss(at)} ${type}${Object.keys(rest).length ? " " + JSON.stringify(rest) : ""}`; }).join(" | "));
  console.log("event counts: " + Object.entries(r.counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" "));
}

async function main() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  if (fileIdx >= 0) {
    const file = args[fileIdx + 1];
    print(analyse(path.basename(file, ".json"), JSON.parse(fs.readFileSync(file, "utf8"))));
    return;
  }
  const headers = await login();
  let codes = args.filter((a) => !a.startsWith("--"));
  const assessIdx = args.indexOf("--assessment");
  if (assessIdx >= 0) {
    const needle = String(args[assessIdx + 1] || "").toLowerCase();
    const res = await fetch(`${BASE}/api/admin/codes`, { headers });
    const { codes: all } = await res.json();
    codes = all.filter((c) => String(c.assessment_title || "").toLowerCase().includes(needle) && (c.status === "submitted" || c.frames > 0)).map((c) => c.code);
  }
  if (!codes.length) throw new Error("no codes given (pass codes, or --assessment <title fragment>)");
  const summary = [];
  for (const code of codes) {
    const res = await fetch(`${BASE}/api/admin/sessions/${code.toUpperCase()}`, { headers });
    if (!res.ok) { console.log(`\n## ${code}: HTTP ${res.status}`); continue; }
    const r = analyse(code.toUpperCase(), await res.json());
    print(r);
    summary.push(r);
  }
  console.log("\n| Code | Candidate | Session | Hidden | Words hidden | Words visible | Worst gap | Hidden chunks/30s |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of summary) {
    console.log(`| ${r.code} | ${r.candidate} | ${mmss(r.endSec)} | ${mmss(r.hiddenSec)} | ${r.wordsHidden} | ${r.wordsVisible} | ${mmss(r.worstGap)} | ${r.chunksHidden ?? "n/a"} |`);
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
