import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";
import { db, getCode, newCodes, SUBMISSIONS_DIR } from "./db.js";
import { requireAdmin } from "./auth.js";

const FRAME_RE = /^[A-Za-z0-9._-]{1,64}\.(jpg|jpeg|png)$/;

export const adminRouter = Router();
adminRouter.use(requireAdmin);

adminRouter.get("/codes", (req, res) => {
  const rows = db.prepare("SELECT * FROM codes ORDER BY created_at DESC").all();
  const withFrames = rows.map((row) => {
    const framesDir = path.join(SUBMISSIONS_DIR, row.code, "frames");
    let frames = 0;
    try { frames = fs.readdirSync(framesDir).length; } catch {}
    return { ...row, frames };
  });
  res.json({ codes: withFrames });
});

adminRouter.post("/codes", (req, res) => {
  const count = Number(req.body?.count) || 1;
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    return res.status(400).json({ error: "count must be 1-200" });
  }
  res.json({ codes: newCodes(count) });
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
  const candidate = row.candidate_name
    ? { name: row.candidate_name, email: row.candidate_email, upwork: row.candidate_upwork }
    : null;
  res.json({ code: row, candidate, payload, frames });
});

adminRouter.get("/sessions/:code/frames/:name", (req, res) => {
  const row = getCode(String(req.params.code || "").toUpperCase());
  const name = path.basename(req.params.name || "");
  if (!row || !FRAME_RE.test(name)) return res.status(404).end();
  res.sendFile(path.join(SUBMISSIONS_DIR, row.code, "frames", name), (err) => {
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
