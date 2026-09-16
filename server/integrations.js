import { Router } from "express";
import { newCodes, getCode, getAssessment, listAssessments, getCodeByClientRef, issueCodeForClientRef, CLIENT_REF_RE } from "./db.js";
import { requireApiKey } from "./auth.js";
import { sweepExpiredSessions } from "./assessment-session.js";

/* Machine-to-machine surface for external tools (currently: the Upwork
   candidate-management Chrome extension) to issue and check single-use
   assessment codes without a browser session. Kept separate from
   /api/admin (cookie/JWT-gated, built for the admin UI) rather than
   layering a second auth scheme onto those routes. */
export const integrationsRouter = Router();
integrationsRouter.use(requireApiKey);
integrationsRouter.use((_req, res, next) => {
  try {
    sweepExpiredSessions();
    next();
  } catch (error) {
    console.error(`assessment session sweep failed: ${error.message}`);
    res.status(500).json({ error: "Could not verify assessment session state." });
  }
});

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
const linkFor = (req, code) => `${req.protocol}://${req.get("host")}/assess?case=${code}`;

function readClientRef(raw) {
  if (raw === undefined || raw === null || raw === "") return { clientRef: null };
  const clientRef = String(raw).trim();
  if (!CLIENT_REF_RE.test(clientRef)) return { error: "clientRef must be 1-128 characters of letters, digits, . _ : @ + -" };
  return { clientRef };
}

/* `clientRef` makes issuance idempotent: an integration that tags the request
   with its own reference (say, its candidate id) and then loses the response
   can simply repeat the call and receive the code it already holds. Without it
   a retry after a timeout mints a second, orphaned code. */
integrationsRouter.post("/codes", (req, res) => {
  let assessmentId = null;
  if (req.body?.assessmentId !== undefined && req.body?.assessmentId !== null && req.body?.assessmentId !== "") {
    assessmentId = Number(req.body.assessmentId);
    if (!getAssessment(assessmentId)) return res.status(400).json({ error: "unknown assessmentId" });
  }
  const ref = readClientRef(req.body?.clientRef);
  if (ref.error) return res.status(400).json({ error: ref.error });
  if (!ref.clientRef) {
    const [code] = newCodes(1, assessmentId);
    return res.json({ code, url: linkFor(req, code) });
  }
  const { code, reused } = issueCodeForClientRef(assessmentId, ref.clientRef);
  res.json({ code, url: linkFor(req, code), clientRef: ref.clientRef, reused });
});

/* Reconciliation lookup: did an earlier request under this reference mint a
   code? 404 means no — the caller may safely issue again. */
integrationsRouter.get("/codes", (req, res) => {
  const ref = readClientRef(req.query?.clientRef);
  if (ref.error) return res.status(400).json({ error: ref.error });
  if (!ref.clientRef) return res.status(400).json({ error: "clientRef query parameter is required" });
  const row = getCodeByClientRef(ref.clientRef);
  if (!row) return res.status(404).json({ error: "no code under this clientRef", clientRef: ref.clientRef });
  res.json({
    code: row.code,
    url: linkFor(req, row.code),
    clientRef: row.client_ref,
    status: row.status,
    assessmentId: row.assessment_id,
    createdAt: row.created_at,
  });
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
