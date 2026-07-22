import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
export const SUBMISSIONS_DIR = path.join(DATA_DIR, "submissions");

fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "assessment.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL,
    upwork        TEXT NOT NULL DEFAULT '',
    role          TEXT NOT NULL DEFAULT 'candidate',   -- candidate | admin
    created_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS codes (
    code         TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'unused',       -- unused|active|submitted|void
    user_id      INTEGER REFERENCES users(id),
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    submitted_at TEXT,
    end_reason   TEXT
  );
  CREATE TABLE IF NOT EXISTS assessments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT NOT NULL,
    brief           TEXT NOT NULL DEFAULT '',
    duration_minutes INTEGER NOT NULL DEFAULT 15,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
`);

/* Candidate details live on the code itself — no candidate accounts. */
for (const col of ["candidate_name", "candidate_email", "candidate_upwork"]) {
  try { db.exec(`ALTER TABLE codes ADD COLUMN ${col} TEXT`); } catch { /* exists */ }
}
/* Codes are issued under an assessment; nullable so pre-existing codes keep working. */
try { db.exec(`ALTER TABLE codes ADD COLUMN assessment_id INTEGER REFERENCES assessments(id)`); } catch { /* exists */ }
try { db.exec(`ALTER TABLE assessments ADD COLUMN duration_minutes INTEGER NOT NULL DEFAULT 15`); } catch { /* exists */ }

export const DEFAULT_DURATION_MINUTES = 15;

export const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
export const CODE_RE = /^[A-Z0-9]{6}$/;

export function newCodes(count, assessmentId = null) {
  const insert = db.prepare("INSERT INTO codes (code, created_at, assessment_id) VALUES (?, ?, ?)");
  const issued = [];
  while (issued.length < count) {
    let code = "";
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    try {
      insert.run(code, nowIso(), assessmentId);
      issued.push(code);
    } catch { /* collision — retry */ }
  }
  return issued;
}

export function getCode(code) {
  if (!code || !CODE_RE.test(code)) return null;
  return db.prepare("SELECT * FROM codes WHERE code = ?").get(code) || null;
}

/* ---------------- assessments (document-style briefs, issued to codes) ---------------- */
export function listAssessments() {
  return db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM codes c WHERE c.assessment_id = a.id) AS code_count
    FROM assessments a ORDER BY a.updated_at DESC
  `).all();
}

export function getAssessment(id) {
  return db.prepare("SELECT * FROM assessments WHERE id = ?").get(id) || null;
}

export function createAssessment({ title, brief, durationMinutes }) {
  const ts = nowIso();
  const info = db.prepare(
    "INSERT INTO assessments (title, brief, duration_minutes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(title, brief || "", durationMinutes || DEFAULT_DURATION_MINUTES, ts, ts);
  return getAssessment(info.lastInsertRowid);
}

export function updateAssessment(id, { title, brief, durationMinutes }) {
  db.prepare("UPDATE assessments SET title = ?, brief = ?, duration_minutes = ?, updated_at = ? WHERE id = ?")
    .run(title, brief || "", durationMinutes || DEFAULT_DURATION_MINUTES, nowIso(), id);
  return getAssessment(id);
}

export function deleteAssessment(id) {
  db.prepare("DELETE FROM assessments WHERE id = ?").run(id);
}

export function caseDir(code, ...sub) {
  const dir = path.join(SUBMISSIONS_DIR, code, ...sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* Seed or update the admin account from env. */
export function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!email || !password) {
    console.log("ADMIN_EMAIL / ADMIN_PASSWORD not set — no admin account seeded.");
    return;
  }
  const hash = bcrypt.hashSync(password, 10);
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?").run(hash, existing.id);
  } else {
    db.prepare(
      "INSERT INTO users (email, password_hash, name, role, created_at) VALUES (?, ?, 'Admin', 'admin', ?)"
    ).run(email, hash, nowIso());
  }
  console.log(`admin account ready: ${email}`);
}

/* JWT secret: env, or generated once and persisted so restarts keep sessions. */
export function jwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretPath = path.join(DATA_DIR, ".jwt-secret");
  try {
    return fs.readFileSync(secretPath, "utf-8").trim();
  } catch {
    const secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    return secret;
  }
}
