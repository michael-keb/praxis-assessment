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
`);

/* Candidate details live on the code itself — no candidate accounts. */
for (const col of ["candidate_name", "candidate_email", "candidate_upwork"]) {
  try { db.exec(`ALTER TABLE codes ADD COLUMN ${col} TEXT`); } catch { /* exists */ }
}

export const nowIso = () => new Date().toISOString().slice(0, 19) + "Z";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
export const CODE_RE = /^[A-Z0-9]{6}$/;

export function newCodes(count) {
  const insert = db.prepare("INSERT INTO codes (code, created_at) VALUES (?, ?)");
  const issued = [];
  while (issued.length < count) {
    let code = "";
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    try {
      insert.run(code, nowIso());
      issued.push(code);
    } catch { /* collision — retry */ }
  }
  return issued;
}

export function getCode(code) {
  if (!code || !CODE_RE.test(code)) return null;
  return db.prepare("SELECT * FROM codes WHERE code = ?").get(code) || null;
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
