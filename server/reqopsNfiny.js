import { Router } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { jwtSecret } from "./db.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATIC_DIR = path.join(ROOT, "static", "reqops", "nfiny");
const COOKIE = "reqops_nfiny_session";
const WEEK = 7 * 24 * 3600 * 1000;
const DEFAULT_PASSWORD = "Reqops2026";
const DEFAULT_RM_URL = "http://127.0.0.1:8125";
const JOB_ID = "94319799";

function portalPassword() {
  return process.env.REQOPS_NFINY_PASSWORD || DEFAULT_PASSWORD;
}

function recruitmentBaseUrl() {
  return String(process.env.RECRUITMENT_MANAGER_API_URL || DEFAULT_RM_URL).replace(/\/$/, "");
}

function setPortalSession(res) {
  const token = jwt.sign({ portal: "reqops_nfiny" }, jwtSecret(), { expiresIn: "7d" });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: WEEK,
    path: "/reqops/nfiny",
  });
}

function clearPortalSession(res) {
  res.clearCookie(COOKIE, { path: "/reqops/nfiny" });
}

function isPortalAuthed(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return false;
  try {
    const payload = jwt.verify(token, jwtSecret());
    return payload.portal === "reqops_nfiny";
  } catch {
    return false;
  }
}

function requirePortalAuth(req, res, next) {
  if (!isPortalAuthed(req)) {
    return res.status(401).json({ ok: false, error: "Authentication required" });
  }
  next();
}

function passwordsMatch(provided, expected) {
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function mountReqopsNfiny(app) {
  if (!fs.existsSync(STATIC_DIR)) return;

  const router = Router();

  router.get("/", (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, "index.html"));
  });

  router.get("/api/me", (req, res) => {
    res.json({ ok: true, authenticated: isPortalAuthed(req) });
  });

  router.post("/api/login", (req, res) => {
    const password = String(req.body?.password || "");
    if (!passwordsMatch(password, portalPassword())) {
      return res.status(401).json({ ok: false, error: "Incorrect password." });
    }
    setPortalSession(res);
    res.json({ ok: true });
  });

  router.post("/api/logout", (_req, res) => {
    clearPortalSession(res);
    res.json({ ok: true });
  });

  router.get("/api/command-center", requirePortalAuth, async (req, res) => {
    const qs = new URLSearchParams({
      platform: req.query.platform || "seek_email",
      jobId: req.query.jobId || JOB_ID,
      limit: String(req.query.limit || 5000),
    });
    if (req.query.activeOnly === "true") qs.set("activeOnly", "true");

    const upstream = `${recruitmentBaseUrl()}/api/command-center?${qs.toString()}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const response = await fetch(upstream, {
        signal: ctrl.signal,
        headers: { accept: "application/json" },
      });
      clearTimeout(timer);

      const body = await response.text();
      res.status(response.status);
      res.set("content-type", response.headers.get("content-type") || "application/json");
      res.send(body);
    } catch (err) {
      res.status(502).json({
        ok: false,
        error:
          "Could not reach Recruitment Manager. Set RECRUITMENT_MANAGER_API_URL on the assessment server.",
        detail: String(err.message || err),
      });
    }
  });

  app.use("/reqops/nfiny", router);

  console.log("  reqops nfiny portal: /reqops/nfiny/ (password modal)");
}
