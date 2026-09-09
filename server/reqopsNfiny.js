import { Router } from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATIC_DIR = path.join(ROOT, "static", "reqops", "nfiny");
const REALM = "ReqOps Governance";
const DEFAULT_PASSWORD = "Reqops2026";
const DEFAULT_RM_URL = "http://127.0.0.1:8125";
const JOB_ID = "94319799";

function portalPassword() {
  return process.env.REQOPS_NFINY_PASSWORD || DEFAULT_PASSWORD;
}

function recruitmentBaseUrl() {
  return String(process.env.RECRUITMENT_MANAGER_API_URL || DEFAULT_RM_URL).replace(/\/$/, "");
}

function unauthorized(res) {
  res.set("WWW-Authenticate", `Basic realm="${REALM}", charset="UTF-8"`);
  return res.status(401).send("Authentication required");
}

function requirePortalAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return unauthorized(res);

  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return unauthorized(res);
  }

  const colon = decoded.indexOf(":");
  const password = colon >= 0 ? decoded.slice(colon + 1) : decoded;
  const expected = portalPassword();
  const a = Buffer.from(String(password));
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return unauthorized(res);
  next();
}

export function mountReqopsNfiny(app) {
  if (!fs.existsSync(STATIC_DIR)) return;

  const router = Router();
  router.use(requirePortalAuth);

  router.get("/", (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, "index.html"));
  });

  router.get("/api/command-center", async (req, res) => {
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

  console.log(`  reqops nfiny portal: /reqops/nfiny/ (password gate)`);
}
