import { Router } from "express";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { jwtSecret } from "./db.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATIC_DIR = path.join(ROOT, "static", "reqops", "nfiny");
const SNAPSHOT_PATH = path.join(ROOT, "server", "portal-data", "reqops-portal-snapshot.json");
const COOKIE = "reqops_nfiny_session";
const WEEK = 7 * 24 * 3600 * 1000;
const DEFAULT_PASSWORD = "Reqops2026";
const DEFAULT_RM_URL = "http://127.0.0.1:8125";
const JOB_ID = "94319799";

let embeddedSnapshot = null;

function portalPassword() {
  return process.env.REQOPS_NFINY_PASSWORD || DEFAULT_PASSWORD;
}

function recruitmentBaseUrl() {
  return String(process.env.RECRUITMENT_MANAGER_API_URL || DEFAULT_RM_URL).replace(/\/$/, "");
}

function loadEmbeddedSnapshot() {
  if (embeddedSnapshot) return embeddedSnapshot;
  if (!fs.existsSync(SNAPSHOT_PATH)) return null;
  try {
    embeddedSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
    return embeddedSnapshot;
  } catch (err) {
    console.error(`  reqops snapshot: failed to read ${SNAPSHOT_PATH}:`, err.message || err);
    return null;
  }
}

function snapshotPayload(req) {
  const snapshot = loadEmbeddedSnapshot();
  if (!snapshot?.ok) return null;

  const platform = req.query.platform || "seek_email";
  const jobId = String(req.query.jobId || JOB_ID);
  const limit = Math.max(1, Number(req.query.limit || 5000));

  if (platform !== snapshot.platform || jobId !== snapshot.jobId) {
    return { ok: true, candidates: [], status: { total: 0, shown: 0, byStage: [], needsReview: 0 } };
  }

  const candidates = (snapshot.candidates || []).slice(0, limit);
  return {
    ok: true,
    source: "embedded_snapshot",
    exportedAt: snapshot.exportedAt,
    status: {
      ...snapshot.status,
      shown: candidates.length,
    },
    candidates,
  };
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

async function fetchLiveCommandCenter(req) {
  const qs = new URLSearchParams({
    platform: req.query.platform || "seek_email",
    jobId: req.query.jobId || JOB_ID,
    limit: String(req.query.limit || 5000),
  });
  if (req.query.activeOnly === "true") qs.set("activeOnly", "true");

  const upstream = `${recruitmentBaseUrl()}/api/command-center?${qs.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const response = await fetch(upstream, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return response.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export function mountReqopsNfiny(app) {
  if (!fs.existsSync(STATIC_DIR)) return;

  const snapshot = loadEmbeddedSnapshot();
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
    const preferLive = process.env.REQOPS_PORTAL_LIVE === "true";
    if (preferLive) {
      const live = await fetchLiveCommandCenter(req);
      if (live?.ok) return res.json(live);
    }

    const embedded = snapshotPayload(req);
    if (embedded) return res.json(embedded);

    res.status(503).json({
      ok: false,
      error: "Portal candidate data is not available.",
    });
  });

  app.use("/reqops/nfiny", router);

  if (snapshot?.candidateCount) {
    console.log(
      `  reqops nfiny portal: /reqops/nfiny/ (${snapshot.candidateCount} candidates from embedded snapshot)`
    );
  } else {
    console.log("  reqops nfiny portal: /reqops/nfiny/ (no embedded snapshot — set REQOPS_PORTAL_LIVE=true with RM URL)");
  }
}
