import { Router } from "express";
import { newCodes, getCode, getAssessment, listAssessments } from "./db.js";
import { requireApiKey } from "./auth.js";

/* Machine-to-machine surface for external tools (currently: the Upwork
   candidate-management Chrome extension) to issue and check single-use
   assessment codes without a browser session. Kept separate from
   /api/admin (cookie/JWT-gated, built for the admin UI) rather than
   layering a second auth scheme onto those routes. */
export const integrationsRouter = Router();
integrationsRouter.use(requireApiKey);

integrationsRouter.get("/ping", (req, res) => {
  res.json({ ok: true });
});

/* The assessments a caller can issue codes against. Titles and ids only —
   the BRIEF is deliberately withheld here: it is the task itself, and no
   caller needs it to issue a code (see assessment.js, where the brief is only
   released once a candidate actually starts). Exists so an integrating tool
   can resolve an assessment id without an admin session. */
integrationsRouter.get("/assessments", (req, res) => {
  res.json({
    assessments: listAssessments().map((a) => ({
      id: a.id,
      title: a.title,
      durationMinutes: a.duration_minutes,
    })),
  });
});

/* Issue one code, optionally under a specific assessment. The candidate's
   name/LinkedIn/Upwork URL are NOT collected here — the platform captures
   those itself when the candidate opens the link and starts the session
   (see assessment.js `/start`), so callers only need a code to send. */
integrationsRouter.post("/codes", (req, res) => {
  let assessmentId = null;
  if (req.body?.assessmentId !== undefined && req.body?.assessmentId !== null && req.body?.assessmentId !== "") {
    assessmentId = Number(req.body.assessmentId);
    if (!getAssessment(assessmentId)) return res.status(400).json({ error: "unknown assessmentId" });
  }
  const [code] = newCodes(1, assessmentId);
  const url = `${req.protocol}://${req.get("host")}/assess?case=${code}`;
  res.json({ code, url });
});

/* Status check — deliberately returns only what a caller needs to track
   funnel state (not the full admin row: no internal IDs, no end_reason). */
integrationsRouter.get("/codes/:code", (req, res) => {
  const row = getCode(String(req.params.code || "").toUpperCase());
  if (!row) return res.status(404).json({ error: "unknown code" });
  res.json({
    code: row.code,
    status: row.status, // unused | active | submitted | void
    candidateName: row.candidate_name || null,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
  });
});
