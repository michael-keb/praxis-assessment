import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { db, getCode, nowIso, caseDir, getAssessment } from "./db.js";

const FRAME_RE = /^[A-Za-z0-9._-]{1,64}\.(jpg|jpeg|png)$/;
const AUDIO_RE = /^[A-Za-z0-9._-]{1,80}\.(webm|ogg|m4a|mp4|mp3)$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UPWORK_RE = /^https?:\/\/(www\.)?upwork\.com\/.+/i;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 120 } });
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024, files: 8 } });

/* No candidate accounts: identity is the details captured at the gate,
   bound to the single-use code. Admin routes stay behind auth. */
export const assessmentRouter = Router();

/* The brief is only released once the code is active — an unused code must
   not leak the task to a candidate who hasn't started (and consented). */
function assessmentPayload(row, { withBrief }) {
  const assessment = row.assessment_id ? getAssessment(row.assessment_id) : null;
  if (!assessment) return null;
  const out = { title: assessment.title, durationSeconds: assessment.duration_minutes * 60 };
  if (withBrief) out.brief = assessment.brief;
  return out;
}

/* Code status — public; the gate validates before anything starts. */
assessmentRouter.get("/session", (req, res) => {
  const row = getCode(String(req.query.case || "").trim().toUpperCase());
  if (!row) return res.json({ status: "unknown" });
  res.json({
    status: row.status,
    startedAt: row.started_at,
    endReason: row.end_reason,
    candidateName: row.candidate_name || null,
    assessment: assessmentPayload(row, { withBrief: row.status === "active" })
  });
});

/* Unlock: bind the candidate's details to the code. */
assessmentRouter.post("/start", (req, res) => {
  const row = getCode(String(req.body?.caseId || "").trim().toUpperCase());
  if (!row) return res.status(403).json({ error: "unknown code" });
  if (row.status === "void") return res.status(403).json({ error: "code voided" });
  if (row.status === "submitted") return res.status(403).json({ error: "already submitted" });
  if (row.status === "active") {
    return res.json({ ok: true, assessment: assessmentPayload(row, { withBrief: true }) });   // resume
  }

  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const upwork = String(req.body?.upwork || "").trim();
  if (!name || name.length > 120) return res.status(400).json({ error: "Enter your full name." });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (!UPWORK_RE.test(upwork)) return res.status(400).json({ error: "Enter a valid Upwork profile URL (on upwork.com)." });

  db.prepare(`UPDATE codes SET status='active', started_at=?,
              candidate_name=?, candidate_email=?, candidate_upwork=?
              WHERE code=? AND status='unused'`)
    .run(nowIso(), name, email, upwork, row.code);
  console.log(`session started: ${row.code} by ${name} <${email}>`);
  res.json({ ok: true, assessment: assessmentPayload(row, { withBrief: true }) });
});

/* Final payload. Candidate identity comes from what the server stored at
   start — the payload cannot claim different details. First submission wins. */
assessmentRouter.post("/", (req, res) => {
  const payload = req.body;
  if (!payload || typeof payload !== "object") return res.status(400).json({ error: "invalid json" });
  const row = getCode(String(payload.caseId || "").trim().toUpperCase());
  if (!row || row.status === "void") return res.status(403).json({ error: "unknown or voided code" });
  if (row.status === "submitted") return res.status(409).json({ error: "already submitted" });

  payload._receivedAt = nowIso();
  payload.candidate = {
    name: row.candidate_name || null,
    email: row.candidate_email || null,
    upworkProfile: row.candidate_upwork || null
  };
  const end = [...(payload.log || [])].reverse().find((e) => e.type === "end") || {};
  fs.writeFileSync(path.join(caseDir(row.code), "payload.json"), JSON.stringify(payload, null, 2));
  db.prepare("UPDATE codes SET status='submitted', submitted_at=?, end_reason=? WHERE code=?")
    .run(nowIso(), end.reason || "?", row.code);
  console.log(`payload stored: ${row.code} (${end.reason || "?"}, ${(payload.log || []).length} events)`);
  res.json({ ok: true });
});

/* 1fps frame batches. */
assessmentRouter.post("/frames", upload.array("frames"), (req, res) => {
  const row = getCode(String(req.body?.caseId || "").trim().toUpperCase());
  if (!row || row.status === "void" || row.status === "unused") {
    return res.status(403).json({ error: "unknown or inactive code" });
  }
  const framesDir = caseDir(row.code, "frames");
  let saved = 0;
  for (const file of req.files || []) {
    const name = path.basename(file.originalname);
    if (FRAME_RE.test(name) && file.buffer?.length) {
      fs.writeFileSync(path.join(framesDir, name), file.buffer);
      saved++;
    }
  }
  res.json({ ok: true, saved });
});

/* Voice-over chunks (thinking aloud). */
assessmentRouter.post("/audio", audioUpload.array("audio"), (req, res) => {
  const row = getCode(String(req.body?.caseId || "").trim().toUpperCase());
  if (!row || row.status === "void" || row.status === "unused") {
    return res.status(403).json({ error: "unknown or inactive code" });
  }
  const audioDir = caseDir(row.code, "audio");
  let saved = 0;
  for (const file of req.files || []) {
    const name = path.basename(file.originalname);
    if (AUDIO_RE.test(name) && file.buffer?.length) {
      fs.writeFileSync(path.join(audioDir, name), file.buffer);
      saved++;
    }
  }
  res.json({ ok: true, saved });
});
