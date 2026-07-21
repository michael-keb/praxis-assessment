import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
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
