import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import { db, getCode, caseDir } from "./db.js";
import { ASSEMBLYAI_API_KEY } from "./config.js";
import {
  assessmentSnapshotForStart,
  candidateForPayload,
  checkpointRow,
  checkpointTiming,
  checkpointValue,
  frozenAssessment,
  initialCheckpoint,
  insertInitialCheckpoint,
  issueSessionToken,
  legacySessionError,
  normalizeCheckpoint,
  ownership,
  ownershipError,
  publicAssessment,
  saveCheckpoint,
  sessionTokenFromRequest,
  startedAtMs,
  sweepExpiredSessions,
  verifySessionToken,
  writePayload,
} from "./assessment-session.js";

const FRAME_RE = /^[A-Za-z0-9._-]{1,64}\.(jpg|jpeg|png)$/;
const AUDIO_RE = /^[A-Za-z0-9._-]{1,80}\.(webm|ogg|m4a|mp4|mp3)$/;
const LINKEDIN_RE = /^https?:\/\/(www\.)?linkedin\.com\/.+/i;
const UPWORK_RE = /^https?:\/\/(www\.)?upwork\.com\/.+/i;
const CV_EXT_RE = /\.(pdf|doc|docx)$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;
const PORTFOLIO_MAX = 10;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 120 } });
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024, files: 8 } });
const startUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 11 } });

/* No candidate accounts: a signed browser token races to bind the single-use
   code. Once bound, every resume, checkpoint, submission and upload must prove
   the same owner. */
export const assessmentRouter = Router();

assessmentRouter.use((_req, res, next) => {
  try {
    sweepExpiredSessions();
    next();
  } catch (error) {
    console.error(`assessment session sweep failed: ${error.message}`);
    res.status(500).json({ error: "Could not verify assessment session state." });
  }
});

function currentPublicAssessment(row) {
  const assessment = row.status === "unused"
    ? assessmentSnapshotForStart(row)
    : frozenAssessment(row) || assessmentSnapshotForStart(row);
  return publicAssessment(assessment);
}

function sendOwnershipError(res, reason) {
  const response = ownershipError(reason);
  return res.status(response.status).json(response.body);
}

function tokenFor(req, res) {
  const value = sessionTokenFromRequest(req);
  if (value.error) {
    res.status(400).json({ error: value.error, code: "conflicting_session_tokens" });
    return null;
  }
  if (!value.token) {
    sendOwnershipError(res, "invalid");
    return null;
  }
  return value.token;
}

function ownedSessionBody(row, nowMs = Date.now()) {
  const cpRow = checkpointRow(row.code);
  return {
    ok: true,
    status: row.status,
    owned: true,
    startedAt: startedAtMs(row),
    endReason: row.end_reason || null,
    finalRevision: Number.isSafeInteger(row.final_revision) ? row.final_revision : null,
    candidateName: row.candidate_name || null,
    assessment: frozenAssessment(row),
    checkpoint: checkpointValue(cpRow),
    ...checkpointTiming(cpRow, nowMs),
  };
}

function readStoredPayload(code) {
  try {
    return JSON.parse(fs.readFileSync(path.join(caseDir(code), "payload.json"), "utf-8"));
  } catch {
    return null;
  }
}

function stableEventValue(value) {
  if (Array.isArray(value)) return value.map(stableEventValue);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (key === "late" || key === "receivedAfterServerFinalization") continue;
    if (key === "interim" && value.type === "voice") continue;
    out[key] = stableEventValue(value[key]);
  }
  return out;
}

function eventSignature(event) {
  return JSON.stringify(stableEventValue(event));
}

/* A browser can reconnect after the server used its last durable checkpoint
   to enforce a deadline. Preserve genuinely newer evidence, label it as late,
   and keep the server's original cutoff and end reason authoritative. */
function reconcileLateSubmission(row, incomingBody, ownerId, nowMs) {
  return db.transaction(() => {
    const fresh = getCode(row.code);
    if (!fresh || fresh.status !== "submitted" || fresh.session_owner_id !== ownerId) {
      return { ownerMismatch: true };
    }
    const existing = readStoredPayload(row.code);
    if (!existing?._finalizedByServer) return { duplicate: true, row: fresh };

    const incomingRevision = incomingBody.revision;
    const storedRevision = Number.isSafeInteger(fresh.final_revision) ? fresh.final_revision : 0;
    if (
      Number.isSafeInteger(incomingRevision) &&
      Array.isArray(existing._lateEvidence) &&
      existing._lateEvidence.some((entry) => entry?.revision === incomingRevision)
    ) {
      return { duplicate: true, row: fresh };
    }
    if (!Number.isSafeInteger(incomingRevision) || incomingRevision <= storedRevision) {
      return { conflict: true, row: fresh, storedRevision };
    }
    const claimed = db.prepare(`
      UPDATE codes SET final_revision = ?
      WHERE code = ? AND status = 'submitted' AND session_owner_id = ?
        AND COALESCE(final_revision, 0) < ?
    `).run(incomingRevision, row.code, ownerId, incomingRevision);
    if (claimed.changes !== 1) {
      const latest = getCode(row.code);
      return { conflict: true, row: latest, storedRevision: latest?.final_revision ?? storedRevision };
    }

    const checkpoint = checkpointValue(checkpointRow(row.code)) || {};
    const checkpointLogLength = Array.isArray(checkpoint.log)
      ? checkpoint.log.filter((event) => event?.type !== "end").length
      : 0;
    const baseLog = Array.isArray(existing.log)
      ? existing.log.filter((event) => event?.type !== "end")
      : [];
    const duplicatePool = new Map();
    for (const event of baseLog.slice(checkpointLogLength)) {
      const signature = eventSignature(event);
      duplicatePool.set(signature, (duplicatePool.get(signature) || 0) + 1);
    }
    const late = (Array.isArray(incomingBody.log) ? incomingBody.log : [])
      .slice(checkpointLogLength)
      .filter((event) => event?.type !== "end")
      .filter((event) => {
        const signature = eventSignature(event);
        const duplicates = duplicatePool.get(signature) || 0;
        if (duplicates > 0) {
          duplicatePool.set(signature, duplicates - 1);
          return false;
        }
        return true;
      })
      .map((event) => event && typeof event === "object"
        ? { ...event, late: true, receivedAfterServerFinalization: true }
        : { type: "late_event", value: event, late: true, receivedAfterServerFinalization: true });
    const serverEnd = Array.isArray(existing.log)
      ? [...existing.log].reverse().find((event) => event?.type === "end")
      : null;
    const receivedAt = new Date(nowMs).toISOString();
    const log = [
      ...baseLog,
      ...late,
      {
        type: "late_evidence_received",
        t: serverEnd?.t ?? Math.floor((Number(existing.elapsedMs) || 0) / 1000),
        revision: incomingRevision,
        receivedAt,
      },
      serverEnd || {
        type: "end",
        reason: fresh.end_reason || "pause_limit",
        t: Math.floor((Number(existing.elapsedMs) || 0) / 1000),
      },
    ];
    const lateHistory = Array.isArray(existing._lateEvidence) ? existing._lateEvidence : [];
    const incoming = JSON.parse(JSON.stringify(incomingBody));
    delete incoming.sessionToken;
    const reconciled = {
      ...incoming,
      caseId: fresh.code,
      startedAt: startedAtMs(fresh),
      elapsedMs: existing.elapsedMs,
      pausedTotal: existing.pausedTotal,
      pauseStartedAt: null,
      pendingTranscript: "",
      phase: "submitted",
      done: true,
      doneReason: fresh.end_reason,
      finishedAt: existing.finishedAt || null,
      revision: incomingRevision,
      log,
      candidate: candidateForPayload(fresh),
      _receivedAt: existing._receivedAt,
      _finalizedByServer: true,
      _serverFinalizedAt: existing._serverFinalizedAt || existing._receivedAt,
      _lateEvidence: [...lateHistory, { revision: incomingRevision, receivedAt, events: late.length }],
    };
    writePayload(fresh.code, reconciled);
    return { reconciled: true, row: fresh, revision: incomingRevision, events: late.length };
  })();
}

/* Before start, each page boot receives a fresh signed contender token and
   public assessment metadata without the brief. Once active/submitted, only
   the persisted owner sees the frozen brief and checkpoint. */
assessmentRouter.get("/session", (req, res) => {
  const nowMs = Date.now();
  const row = getCode(String(req.query.case || "").trim().toUpperCase());
  if (!row) return res.json({ status: "unknown", serverNow: nowMs });

  if (row.status === "unused") {
    return res.json({
      status: "unused",
      startedAt: null,
      endReason: null,
      assessment: currentPublicAssessment(row),
      sessionToken: issueSessionToken(row.code),
      serverNow: nowMs,
    });
  }

  if (row.status === "active" || row.status === "submitted") {
    const token = sessionTokenFromRequest(req).token;
    const owner = ownership(row, token);
    if (!owner.ok) {
      const body = {
        status: row.status,
        owned: false,
        startedAt: startedAtMs(row),
        endReason: row.end_reason || null,
        assessment: currentPublicAssessment(row),
        serverNow: nowMs,
      };
      if (owner.reason === "legacy") {
        const legacy = legacySessionError();
        body.error = legacy.error;
        body.errorCode = legacy.code;
        body.recovery = legacy.recovery;
      }
      return res.json(body);
    }
    return res.json(ownedSessionBody(row, nowMs));
  }

  return res.json({
    status: row.status,
    startedAt: startedAtMs(row),
    endReason: row.end_reason || null,
    assessment: currentPublicAssessment(row),
    serverNow: nowMs,
  });
});

function validateStart(snapshot, req) {
  const gate = snapshot.gateFields;
  const name = String(req.body?.name || "").trim();
  const linkedin = String(req.body?.linkedin || "").trim();
  const upwork = String(req.body?.upwork || "").trim();
  const cv = req.files?.cv?.[0];
  const portfolioFiles = req.files?.portfolio || [];

  if (!name || name.length > 120) return { error: "Enter your full name." };
  if (gate.linkedin && !LINKEDIN_RE.test(linkedin)) {
    return { error: "Enter a valid LinkedIn profile URL (on linkedin.com)." };
  }
  if (gate.upwork && !UPWORK_RE.test(upwork)) {
    return { error: "Enter a valid Upwork profile URL (on upwork.com)." };
  }
  if (gate.cv && (!cv || !cv.buffer?.length || !CV_EXT_RE.test(cv.originalname || ""))) {
    return { error: "Attach your CV as a PDF or Word document (.pdf, .doc, .docx)." };
  }
  if (gate.portfolio) {
    const valid = portfolioFiles.filter((file) => file?.buffer?.length && IMAGE_EXT_RE.test(file.originalname || ""));
    if (!valid.length || valid.length > PORTFOLIO_MAX || valid.length !== portfolioFiles.length) {
      return { error: "Upload 1–10 portfolio images (JPG, PNG, or WebP)." };
    }
  }
  return { name, linkedin, upwork, cv, portfolioFiles };
}

function persistStartFiles(code, gate, details) {
  const written = [];
  try {
    let cvName = null;
    if (gate.cv && details.cv) {
      const ext = details.cv.originalname.match(CV_EXT_RE)[0].toLowerCase();
      const filename = path.join(caseDir(code), `cv${ext}`);
      fs.writeFileSync(filename, details.cv.buffer);
      written.push(filename);
      cvName = path.basename(details.cv.originalname).slice(0, 120);
    }

    let portfolioJson = null;
    if (gate.portfolio && details.portfolioFiles.length) {
      const dir = caseDir(code, "portfolio");
      const names = [];
      details.portfolioFiles.forEach((file) => {
        const extMatch = (file.originalname || "").match(IMAGE_EXT_RE);
        const ext = extMatch[0].toLowerCase() === ".jpeg" ? ".jpg" : extMatch[0].toLowerCase();
        const stored = `${String(names.length + 1).padStart(2, "0")}${ext}`;
        const filename = path.join(dir, stored);
        fs.writeFileSync(filename, file.buffer);
        written.push(filename);
        names.push(path.basename(file.originalname).slice(0, 120));
      });
      portfolioJson = JSON.stringify(names);
    }
    return { cvName, portfolioJson };
  } catch (error) {
    written.forEach((filename) => {
      try { fs.unlinkSync(filename); } catch { /* best effort after failed start */ }
    });
    throw error;
  }
}

/* Unlock: atomically bind the contender token, candidate identity, frozen
   assessment and initial checkpoint. A retry from the winning token returns
   the same start time and snapshot without rewriting identity or files. */
assessmentRouter.post("/start", startUpload.fields([
  { name: "cv", maxCount: 1 },
  { name: "portfolio", maxCount: PORTFOLIO_MAX },
]), (req, res) => {
  const code = String(req.body?.caseId || "").trim().toUpperCase();
  const row = getCode(code);
  if (!row) return res.status(403).json({ error: "unknown code" });
  if (row.status === "void") return res.status(403).json({ error: "code voided" });

  const token = tokenFor(req, res);
  if (!token) return;
  const tokenOwner = verifySessionToken(token, row.code);
  if (!tokenOwner) return sendOwnershipError(res, "invalid");

  if (row.status === "active") {
    const owner = ownership(row, token);
    if (!owner.ok) return sendOwnershipError(res, owner.reason);
    return res.json(ownedSessionBody(row));
  }
  if (row.status === "submitted") {
    const owner = ownership(row, token);
    if (!owner.ok) return sendOwnershipError(res, owner.reason);
    return res.status(409).json({ error: "This assessment has already been submitted.", code: "already_submitted" });
  }

  const snapshot = assessmentSnapshotForStart(row);
  const details = validateStart(snapshot, req);
  if (details.error) return res.status(400).json({ error: details.error });
  const startedAt = Date.now();

  let result;
  try {
    result = db.transaction(() => {
      const fresh = getCode(row.code);
      if (fresh.status !== "unused") return { existing: fresh };
      const updated = db.prepare(`
        UPDATE codes SET
          status = 'active', started_at = ?, started_at_ms = ?, session_owner_id = ?, assessment_snapshot = ?,
          candidate_name = ?, candidate_linkedin = ?, candidate_upwork = ?, candidate_cv = NULL, candidate_portfolio = NULL
        WHERE code = ? AND status = 'unused' AND session_owner_id IS NULL
      `).run(
        new Date(startedAt).toISOString(),
        startedAt,
        tokenOwner,
        JSON.stringify(snapshot),
        details.name,
        snapshot.gateFields.linkedin ? details.linkedin : null,
        snapshot.gateFields.upwork ? details.upwork : null,
        row.code
      );
      if (updated.changes !== 1) return { existing: getCode(row.code) };

      const files = persistStartFiles(row.code, snapshot.gateFields, details);
      db.prepare("UPDATE codes SET candidate_cv = ?, candidate_portfolio = ? WHERE code = ?")
        .run(files.cvName, files.portfolioJson, row.code);
      insertInitialCheckpoint(initialCheckpoint({
        code: row.code,
        ownerId: tokenOwner,
        sessionToken: token,
        startedAt,
        nowMs: startedAt,
      }));
      return { started: true, row: getCode(row.code) };
    })();
  } catch (error) {
    console.error(`session start failed ${row.code}: ${error.message}`);
    return res.status(500).json({ error: "The assessment could not be started. Please try again." });
  }

  if (result.existing) {
    if (result.existing.status === "active") {
      const owner = ownership(result.existing, token);
      if (!owner.ok) return sendOwnershipError(res, owner.reason);
      return res.json(ownedSessionBody(result.existing));
    }
    return res.status(409).json({ error: "This assessment is no longer available.", code: `code_${result.existing.status}` });
  }

  console.log(`session started: ${row.code} by ${details.name}`);
  res.json(ownedSessionBody(result.row, startedAt));
});

/* Short-lived AssemblyAI streaming token. Before start, any valid contender
   token may run the microphone check; once active, only the bound owner may
   mint a transcription token. */
assessmentRouter.post("/transcribe-token", async (req, res) => {
  const row = getCode(String(req.body?.caseId || "").trim().toUpperCase());
  if (!row || row.status === "void" || row.status === "submitted") {
    return res.status(403).json({ error: "unknown or inactive code" });
  }
  const token = tokenFor(req, res);
  if (!token) return;
  if (row.status === "unused") {
    if (!verifySessionToken(token, row.code)) return sendOwnershipError(res, "invalid");
  } else {
    const owner = ownership(row, token);
    if (!owner.ok) return sendOwnershipError(res, owner.reason);
  }
  if (!ASSEMBLYAI_API_KEY) return res.status(404).json({ error: "transcription service not configured" });
  try {
    const response = await fetch("https://streaming.assemblyai.com/v3/token?expires_in_seconds=600", {
      headers: { Authorization: ASSEMBLYAI_API_KEY },
    });
    if (!response.ok) throw new Error(`assemblyai responded ${response.status}`);
    const out = await response.json();
    if (!out.token) throw new Error("assemblyai returned no token");
    res.json({ token: out.token });
  } catch (error) {
    console.error(`transcribe-token ${row.code}: ${error.message}`);
    res.status(502).json({ error: "could not reach the transcription service" });
  }
});

/* Durable browser state. Revisions are strictly monotonic; duplicate or older
   deliveries are acknowledged without replacing the newest checkpoint. */
assessmentRouter.post("/checkpoint", (req, res) => {
  const nowMs = Date.now();
  const code = String(req.body?.caseId || "").trim().toUpperCase();
  const row = getCode(code);
  if (!row || row.status === "void") return res.status(403).json({ error: "unknown or voided code" });
  const token = tokenFor(req, res);
  if (!token) return;
  if (!verifySessionToken(token, row.code)) return sendOwnershipError(res, "invalid");
  if (row.status === "unused") {
    return res.status(409).json({ error: "The assessment has not started.", code: "session_not_started" });
  }
  const owner = ownership(row, token);
  if (!owner.ok) return sendOwnershipError(res, owner.reason);
  if (row.status === "submitted") {
    const current = checkpointRow(row.code);
    return res.json({
      ok: true,
      status: "submitted",
      accepted: false,
      revision: current?.revision ?? null,
      startedAt: startedAtMs(row),
      endReason: row.end_reason || null,
      ...checkpointTiming(current, nowMs),
    });
  }

  const normalized = normalizeCheckpoint(req.body, {
    code: row.code,
    sessionToken: token,
    expectedStartedAt: startedAtMs(row),
  });
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  const saved = saveCheckpoint({
    code: row.code,
    ownerId: owner.ownerId,
    checkpoint: normalized.checkpoint,
    nowMs,
  });
  if (saved.ownerMismatch) return sendOwnershipError(res, "mismatch");
  if (saved.error) return res.status(400).json({ error: saved.error, code: "checkpoint_time_regression" });
  sweepExpiredSessions(nowMs);

  const currentCode = getCode(row.code);
  const current = checkpointRow(row.code);
  res.json({
    ok: true,
    status: currentCode.status,
    accepted: saved.accepted,
    revision: current?.revision ?? null,
    startedAt: startedAtMs(currentCode),
    endReason: currentCode.end_reason || null,
    ...checkpointTiming(current, nowMs),
  });
});

/* Final payload. The first owned submission changes status and writes the
   result while holding the SQLite transaction. Same-owner retries receive an
   acknowledgement and cannot replace the stored result. */
assessmentRouter.post("/", (req, res) => {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "invalid json" });
  }
  const row = getCode(String(req.body.caseId || "").trim().toUpperCase());
  if (!row || row.status === "void") return res.status(403).json({ error: "unknown or voided code" });
  const token = tokenFor(req, res);
  if (!token) return;
  const tokenOwner = verifySessionToken(token, row.code);
  if (!tokenOwner) return sendOwnershipError(res, "invalid");
  if (row.status === "unused") {
    return res.status(409).json({ error: "The assessment has not started.", code: "session_not_started" });
  }
  const owner = ownership(row, token);
  if (!owner.ok) return sendOwnershipError(res, owner.reason);
  if (row.status === "submitted") {
    let reconciled;
    try { reconciled = reconcileLateSubmission(row, req.body, tokenOwner, Date.now()); }
    catch (error) {
      console.error(`late payload reconciliation failed ${row.code}: ${error.message}`);
      return res.status(500).json({ error: "The newer evidence could not be saved. Please try again." });
    }
    if (reconciled.ownerMismatch) return sendOwnershipError(res, "mismatch");
    if (reconciled.conflict) {
      return res.status(409).json({
        error: "The server already finalized this assessment and this payload is not newer than its saved checkpoint.",
        code: "server_finalized",
        status: "submitted",
        endReason: reconciled.row?.end_reason || row.end_reason || null,
        storedRevision: reconciled.storedRevision,
      });
    }
    if (reconciled.reconciled) {
      return res.json({
        ok: true,
        acknowledged: true,
        duplicate: false,
        reconciled: true,
        lateEvidenceEvents: reconciled.events,
        revision: reconciled.revision,
        status: "submitted",
        endReason: reconciled.row?.end_reason || row.end_reason || null,
      });
    }
    return res.json({ ok: true, acknowledged: true, duplicate: true, status: "submitted", endReason: row.end_reason || null });
  }

  const receivedAt = Date.now();
  const payload = JSON.parse(JSON.stringify(req.body));
  delete payload.sessionToken;
  payload.caseId = row.code;
  payload.startedAt = startedAtMs(row);
  payload.log = Array.isArray(payload.log) ? payload.log : [];
  payload._receivedAt = new Date(receivedAt).toISOString();
  payload.candidate = candidateForPayload(row);
  const end = [...payload.log].reverse().find((event) => event?.type === "end") || {};
  const endReason = String(end.reason || "submitted");
  const submittedRevision = Number.isSafeInteger(payload.revision)
    ? payload.revision
    : (checkpointRow(row.code)?.revision ?? 0);

  let result;
  try {
    result = db.transaction(() => {
      const fresh = getCode(row.code);
      if (!fresh || !fresh.session_owner_id || fresh.session_owner_id !== tokenOwner) {
        return { ownerMismatch: true };
      }
      if (fresh.status === "submitted") return { duplicate: true, row: fresh };
      if (fresh.status !== "active") return { unavailable: fresh.status };
      const updated = db.prepare(`
        UPDATE codes SET status = 'submitted', submitted_at = ?, end_reason = ?, final_revision = ?
        WHERE code = ? AND status = 'active' AND session_owner_id = ?
      `).run(new Date(receivedAt).toISOString(), endReason, submittedRevision, row.code, tokenOwner);
      if (updated.changes !== 1) {
        const latest = getCode(row.code);
        return latest?.status === "submitted" ? { duplicate: true, row: latest } : { unavailable: latest?.status };
      }
      writePayload(row.code, payload);
      return { stored: true };
    })();
  } catch (error) {
    console.error(`payload store failed ${row.code}: ${error.message}`);
    return res.status(500).json({ error: "The submission could not be saved. Please try again." });
  }

  if (result.ownerMismatch) return sendOwnershipError(res, "mismatch");
  if (result.duplicate) {
    return res.json({
      ok: true,
      acknowledged: true,
      duplicate: true,
      status: "submitted",
      endReason: result.row?.end_reason || null,
    });
  }
  if (!result.stored) return res.status(409).json({ error: "This assessment is no longer active.", code: `code_${result.unavailable}` });

  console.log(`payload stored: ${row.code} (${endReason}, ${payload.log.length} events)`);
  res.json({ ok: true, acknowledged: true, duplicate: false, status: "submitted", endReason });
});

function authorizeUpload(req, res) {
  const row = getCode(String(req.body?.caseId || "").trim().toUpperCase());
  if (!row || row.status === "void" || row.status === "unused") {
    res.status(403).json({ error: "unknown or inactive code" });
    return null;
  }
  const token = tokenFor(req, res);
  if (!token) return null;
  const owner = ownership(row, token);
  if (!owner.ok) {
    sendOwnershipError(res, owner.reason);
    return null;
  }
  return row;
}

/* Late uploads are intentionally allowed after submission so a confirmed
   owner can drain recording queues; ownership still applies in that state. */
assessmentRouter.post("/frames", upload.array("frames"), (req, res) => {
  const row = authorizeUpload(req, res);
  if (!row) return;
  const framesDir = caseDir(row.code, "frames");
  let saved = 0;
  for (const file of req.files || []) {
    const name = path.basename(file.originalname);
    if (FRAME_RE.test(name) && file.buffer?.length) {
      fs.writeFileSync(path.join(framesDir, name), file.buffer);
      saved++;
    }
  }
  res.json({ ok: true, saved, status: row.status });
});

assessmentRouter.post("/audio", audioUpload.array("audio"), (req, res) => {
  const row = authorizeUpload(req, res);
  if (!row) return;
  const audioDir = caseDir(row.code, "audio");
  let saved = 0;
  for (const file of req.files || []) {
    const name = path.basename(file.originalname);
    if (AUDIO_RE.test(name) && file.buffer?.length) {
      fs.writeFileSync(path.join(audioDir, name), file.buffer);
      saved++;
    }
  }
  res.json({ ok: true, saved, status: row.status });
});
