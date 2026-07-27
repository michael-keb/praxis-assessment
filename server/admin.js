import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import {
  db, getCode, newCodes, SUBMISSIONS_DIR,
  listAssessments, getAssessment, createAssessment, updateAssessment, deleteAssessment
} from "./db.js";
import { requireAdmin } from "./auth.js";

const FRAME_RE = /^[A-Za-z0-9._-]{1,64}\.(jpg|jpeg|png)$/;
const AUDIO_RE = /^[A-Za-z0-9._-]{1,80}\.(webm|ogg|m4a|mp4|mp3)$/;

export const adminRouter = Router();
adminRouter.use(requireAdmin);

/* ---------------- assessments ---------------- */
adminRouter.get("/assessments", (req, res) => {
  res.json({ assessments: listAssessments() });
});

function parseDuration(body) {
  const n = Number(body?.durationMinutes);
  if (!Number.isInteger(n) || n < 1 || n > 180) return { error: "Duration must be 1-180 minutes." };
  return { value: n };
}

adminRouter.post("/assessments", (req, res) => {
  const title = String(req.body?.title || "").trim();
  const brief = String(req.body?.brief || "");
  if (!title) return res.status(400).json({ error: "Title is required." });
  const duration = parseDuration(req.body);
  if (duration.error) return res.status(400).json({ error: duration.error });
  res.json({ assessment: createAssessment({ title, brief, durationMinutes: duration.value }) });
});

adminRouter.get("/assessments/:id", (req, res) => {
  const row = getAssessment(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "unknown assessment" });
  res.json({ assessment: row });
});

adminRouter.put("/assessments/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!getAssessment(id)) return res.status(404).json({ error: "unknown assessment" });
  const title = String(req.body?.title || "").trim();
  const brief = String(req.body?.brief || "");
  if (!title) return res.status(400).json({ error: "Title is required." });
  const duration = parseDuration(req.body);
  if (duration.error) return res.status(400).json({ error: duration.error });
  res.json({ assessment: updateAssessment(id, { title, brief, durationMinutes: duration.value }) });
});

adminRouter.delete("/assessments/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!getAssessment(id)) return res.status(404).json({ error: "unknown assessment" });
  const used = db.prepare("SELECT COUNT(*) AS n FROM codes WHERE assessment_id = ?").get(id).n;
  if (used > 0) return res.status(409).json({ error: "Codes have already been issued under this assessment — void them first." });
  deleteAssessment(id);
  res.json({ ok: true });
});

/* ---------------- codes ---------------- */
adminRouter.get("/codes", (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, a.title AS assessment_title
    FROM codes c LEFT JOIN assessments a ON a.id = c.assessment_id
    ORDER BY c.created_at DESC
  `).all();
  const withFrames = rows.map((row) => {
    const framesDir = path.join(SUBMISSIONS_DIR, row.code, "frames");
    const audioDir = path.join(SUBMISSIONS_DIR, row.code, "audio");
    let frames = 0;
    let audio = 0;
    try { frames = fs.readdirSync(framesDir).length; } catch {}
    try { audio = fs.readdirSync(audioDir).length; } catch {}
    return { ...row, frames, audio };
  });
  res.json({ codes: withFrames });
});

adminRouter.post("/codes", (req, res) => {
  const count = Number(req.body?.count) || 1;
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return res.status(400).json({ error: "count must be 1-200" });
  }
  let assessmentId = null;
  if (req.body?.assessmentId !== undefined && req.body?.assessmentId !== null && req.body?.assessmentId !== "") {
    assessmentId = Number(req.body.assessmentId);
    if (!getAssessment(assessmentId)) return res.status(400).json({ error: "unknown assessment" });
  }
  res.json({ codes: newCodes(count, assessmentId) });
});

adminRouter.post("/codes/:code/void", (req, res) => {
  const row = getCode(String(req.params.code || "").toUpperCase());
  if (!row) return res.status(404).json({ error: "unknown code" });
  db.prepare("UPDATE codes SET status='void' WHERE code=?").run(row.code);
  res.json({ ok: true });
});

adminRouter.get("/sessions/:code", (req, res) => {
  const row = getCode(String(req.params.code || "").toUpperCase());
  if (!row) return res.status(404).json({ error: "unknown code" });
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(path.join(SUBMISSIONS_DIR, row.code, "payload.json"), "utf-8"));
  } catch {}
  let frames = [];
  try {
    frames = fs.readdirSync(path.join(SUBMISSIONS_DIR, row.code, "frames"))
      .filter((n) => FRAME_RE.test(n))
      .sort((a, b) => (parseInt(a.match(/f_(\d+)/)?.[1] || 0, 10)) - (parseInt(b.match(/f_(\d+)/)?.[1] || 0, 10)));
  } catch {}
  let audio = [];
  try {
    audio = fs.readdirSync(path.join(SUBMISSIONS_DIR, row.code, "audio"))
      .filter((n) => AUDIO_RE.test(n))
      .sort();
  } catch {}
  const candidate = row.candidate_name
    ? { name: row.candidate_name, cv: row.candidate_cv, linkedin: row.candidate_linkedin, email: row.candidate_email, upwork: row.candidate_upwork }
    : null;
  res.json({ code: row, candidate, payload, frames, audio });
});

/* The CV uploaded at the gate. Stored as cv.<ext> in the case directory;
   downloaded under the candidate's original filename. */
adminRouter.get("/sessions/:code/cv", (req, res) => {
  const row = getCode(String(req.params.code || "").toUpperCase());
  if (!row) return res.status(404).end();
  const dir = path.join(SUBMISSIONS_DIR, row.code);
  const file = ["cv.pdf", "cv.doc", "cv.docx"].find((n) => fs.existsSync(path.join(dir, n)));
  if (!file) return res.status(404).end();
  res.download(path.join(dir, file), row.candidate_cv || file);
});

adminRouter.get("/sessions/:code/frames/:name", (req, res) => {
  const row = getCode(String(req.params.code || "").toUpperCase());
  const name = path.basename(req.params.name || "");
  if (!row || !FRAME_RE.test(name)) return res.status(404).end();
  res.sendFile(path.join(SUBMISSIONS_DIR, row.code, "frames", name), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

adminRouter.get("/sessions/:code/audio/:name", (req, res) => {
  const row = getCode(String(req.params.code || "").toUpperCase());
  const name = path.basename(req.params.name || "");
  if (!row || !AUDIO_RE.test(name)) return res.status(404).end();
  res.sendFile(path.join(SUBMISSIONS_DIR, row.code, "audio", name), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

adminRouter.get("/sessions/:code/zip", (req, res) => {
  const row = getCode(String(req.params.code || "").toUpperCase());
  if (!row) return res.status(404).json({ error: "unknown code" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=${row.code}.zip`);
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.pipe(res);
  const root = path.join(SUBMISSIONS_DIR, row.code);
  if (fs.existsSync(root)) archive.directory(root, row.code);
  archive.append(JSON.stringify(row, null, 2), { name: `${row.code}/code-record.json` });
  archive.finalize();
});
