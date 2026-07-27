import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { db, jwtSecret } from "./db.js";

const SECRET = jwtSecret();
const COOKIE = "praxis_session";
const WEEK = 7 * 24 * 3600 * 1000;

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id }, SECRET, { expiresIn: "7d" });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: WEEK
  });
}

export function currentUser(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  try {
    const { uid } = jwt.verify(token, SECRET);
    return db.prepare("SELECT id, email, name, upwork, role FROM users WHERE id = ?").get(uid) || null;
  } catch {
    return null;
  }
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "not signed in" });
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user || user.role !== "admin") return res.status(403).json({ error: "forbidden" });
  req.user = user;
  next();
}

/* Machine-to-machine auth for server-side integrations (e.g. the Upwork
   candidate-management extension) — a single shared secret, not a user
   session, since there's no browser to hold a cookie. Same env-var pattern
   as ADMIN_EMAIL/ADMIN_PASSWORD in db.js. */
export function requireApiKey(req, res, next) {
  const expected = process.env.EXTENSION_API_KEY || "";
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  const valid =
    expected.length > 0 &&
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, providedBuf);
  if (!valid) return res.status(401).json({ error: "invalid or missing API key" });
  next();
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, upwork: u.upwork, role: u.role });

export const authRouter = Router();

/* No candidate signup — accounts exist only for admins (seeded from env). */
authRouter.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase());
  if (!user || !bcrypt.compareSync(String(password || ""), user.password_hash)) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

authRouter.post("/logout", (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

authRouter.get("/me", (req, res) => {
  const user = currentUser(req);
  res.json({ user: user ? publicUser(user) : null });
});
