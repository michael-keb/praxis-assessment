import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import {
  db,
  caseDir,
  getAssessment,
  gateFieldsFromAssessment,
  jwtSecret,
} from "./db.js";

export const PAUSE_LIMIT_MS = 5 * 60 * 1000;
export const DEFAULT_ASSESSMENT_SNAPSHOT = Object.freeze({
  title: "Assessment",
  brief: "",
  durationSeconds: 15 * 60,
  gateFields: Object.freeze({ linkedin: true, upwork: false, cv: false, portfolio: false }),
});

const SESSION_TOKEN_KIND = "assessment-session-v1";
const SESSION_SECRET = jwtSecret();
const CHECKPOINT_PHASES = new Set(["running", "blocked", "submitting"]);
const SERIALIZATION_TOLERANCE_MS = 2_000;
const MONOTONIC_TOLERANCE_MS = 50;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function assessmentSnapshotForStart(codeRow) {
  const assessment = codeRow?.assessment_id ? getAssessment(codeRow.assessment_id) : null;
  if (!assessment) return clone(DEFAULT_ASSESSMENT_SNAPSHOT);
  const durationMinutes = Number(assessment.duration_minutes);
  return {
    title: String(assessment.title || DEFAULT_ASSESSMENT_SNAPSHOT.title),
    brief: String(assessment.brief || ""),
    durationSeconds: Number.isFinite(durationMinutes) && durationMinutes >= 1
      ? Math.floor(durationMinutes * 60)
      : DEFAULT_ASSESSMENT_SNAPSHOT.durationSeconds,
    gateFields: gateFieldsFromAssessment(assessment),
  };
}

export function frozenAssessment(codeRow) {
  const value = parseJson(codeRow?.assessment_snapshot);
  if (!value || typeof value !== "object") return null;
  return value;
}

export function publicAssessment(assessment) {
  if (!assessment) return null;
  const { brief: _brief, ...metadata } = assessment;
  return metadata;
}

export function startedAtMs(codeRow) {
  const stored = Number(codeRow?.started_at_ms);
  if (Number.isSafeInteger(stored) && stored > 0) return stored;
  const legacy = Date.parse(codeRow?.started_at || "");
  return Number.isFinite(legacy) ? legacy : null;
}

export function sessionGeneration(codeRow) {
  const generation = Number(codeRow?.session_generation);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : 0;
}

export function issueSessionToken(code, generation = 0) {
  const ownerId = crypto.randomBytes(24).toString("base64url");
  return jwt.sign(
    { kind: SESSION_TOKEN_KIND, caseId: code, ownerId, sessionGeneration: generation },
    SESSION_SECRET,
    { algorithm: "HS256", jwtid: ownerId }
  );
}

export function sessionTokenFromRequest(req) {
  const header = typeof req.get === "function"
    ? String(req.get("X-Assessment-Session") || "").trim()
    : "";
  const body = typeof req.body?.sessionToken === "string" ? req.body.sessionToken.trim() : "";
  if (header && body && header !== body) {
    return { token: null, error: "Conflicting assessment session tokens." };
  }
  return { token: header || body || null, error: null };
}

export function verifySessionTokenDetails(token, code, expectedGeneration = 0) {
  if (!token) return { ok: false, reason: "invalid" };
  try {
    const claims = jwt.verify(token, SESSION_SECRET, { algorithms: ["HS256"] });
    const tokenGeneration = claims?.sessionGeneration === undefined ? 0 : claims.sessionGeneration;
    if (
      claims?.kind !== SESSION_TOKEN_KIND ||
      claims?.caseId !== code ||
      !Number.isSafeInteger(tokenGeneration) ||
      typeof claims?.ownerId !== "string" ||
      claims.ownerId.length < 16 ||
      (claims.jti && claims.jti !== claims.ownerId)
    ) return { ok: false, reason: "invalid" };
    if (tokenGeneration !== expectedGeneration) {
      return { ok: false, reason: "generation", tokenGeneration };
    }
    return { ok: true, ownerId: claims.ownerId, tokenGeneration };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

export function verifySessionToken(token, code, expectedGeneration = 0) {
  const result = verifySessionTokenDetails(token, code, expectedGeneration);
  return result.ok ? result.ownerId : null;
}

export function ownership(codeRow, token) {
  if (!codeRow?.session_owner_id) return { ok: false, reason: "legacy" };
  const verified = verifySessionTokenDetails(token, codeRow?.code, sessionGeneration(codeRow));
  if (!verified.ok) return { ok: false, reason: verified.reason };
  const ownerId = verified.ownerId;
  if (!safeEqual(ownerId, codeRow.session_owner_id)) {
    return { ok: false, reason: "mismatch", ownerId };
  }
  return { ok: true, ownerId };
}

export function legacySessionError() {
  return {
    error: "This session predates secure browser ownership and cannot be resumed safely.",
    code: "legacy_owner_unavailable",
    recovery: "An admin must review any existing evidence, then void this code and issue a new one if the candidate needs to continue.",
  };
}

export function ownershipError(reason) {
  if (reason === "legacy") return { status: 409, body: legacySessionError() };
  if (reason === "generation") {
    return {
      status: 409,
      body: {
        error: "This assessment link was reset. Reload this same link to begin the current session.",
        code: "session_generation_mismatch",
        recovery: "Reload this same assessment link before continuing.",
      },
    };
  }
  if (reason === "mismatch") {
    return {
      status: 409,
      body: {
        error: "This assessment is already bound to another browser session.",
        code: "session_owner_mismatch",
      },
    };
  }
  return {
    status: 403,
    body: { error: "A valid assessment session token is required.", code: "invalid_session_token" },
  };
}

export function checkpointRow(code) {
  return db.prepare("SELECT * FROM session_checkpoints WHERE code = ?").get(code) || null;
}

export function checkpointValue(row, { redactToken = false } = {}) {
  const value = parseJson(row?.checkpoint_json);
  if (!value) return null;
  if (redactToken) delete value.sessionToken;
  return value;
}

export function initialCheckpoint({ code, ownerId, sessionToken, sessionGeneration: generation = 0, startedAt, nowMs = Date.now() }) {
  return {
    caseId: code,
    sessionToken,
    sessionGeneration: generation,
    startedAt,
    pausedTotal: 0,
    pauseStartedAt: null,
    lastSavedAt: startedAt,
    log: [],
    revision: 0,
    phase: "running",
    elapsedMs: 0,
    pendingTranscript: "",
    _ownerId: ownerId,
    _receivedAt: nowMs,
  };
}

/* _ownerId and _receivedAt are internal construction fields. They are never
   persisted inside checkpoint_json or returned to a candidate. */
export function insertInitialCheckpoint(value) {
  const checkpoint = { ...value };
  const ownerId = checkpoint._ownerId;
  const receivedAt = checkpoint._receivedAt;
  delete checkpoint._ownerId;
  delete checkpoint._receivedAt;
  db.prepare(`
    INSERT INTO session_checkpoints (
      code, owner_id, checkpoint_json, revision, started_at_ms,
      paused_total_ms, pause_started_at_ms, last_saved_at_ms,
      elapsed_ms, phase, received_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    checkpoint.caseId,
    ownerId,
    JSON.stringify(checkpoint),
    checkpoint.revision,
    checkpoint.startedAt,
    checkpoint.pausedTotal,
    checkpoint.pauseStartedAt,
    checkpoint.lastSavedAt,
    checkpoint.elapsedMs,
    checkpoint.phase,
    receivedAt
  );
  return checkpoint;
}

function validMs(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function normalizeCheckpoint(input, { code, sessionToken, expectedStartedAt, expectedGeneration = 0 }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "Checkpoint must be a JSON object." };
  }
  if (String(input.caseId || "").trim().toUpperCase() !== code) {
    return { error: "Checkpoint caseId does not match the session." };
  }
  if (!validMs(input.startedAt) || input.startedAt !== expectedStartedAt) {
    return { error: "Checkpoint startedAt does not match the server start time." };
  }
  if (!validMs(input.pausedTotal)) return { error: "Checkpoint pausedTotal must be a non-negative integer in milliseconds." };
  if (input.pauseStartedAt !== null && !validMs(input.pauseStartedAt)) {
    return { error: "Checkpoint pauseStartedAt must be null or a non-negative integer in milliseconds." };
  }
  if (!validMs(input.lastSavedAt)) return { error: "Checkpoint lastSavedAt must be a non-negative integer in milliseconds." };
  if (!Array.isArray(input.log)) return { error: "Checkpoint log must be an array." };
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    return { error: "Checkpoint revision must be a non-negative integer." };
  }
  if (!CHECKPOINT_PHASES.has(input.phase)) {
    return { error: "Checkpoint phase must be running, blocked, or submitting." };
  }
  if (!validMs(input.elapsedMs)) return { error: "Checkpoint elapsedMs must be a non-negative integer in milliseconds." };
  if (input.pendingTranscript !== undefined && typeof input.pendingTranscript !== "string") {
    return { error: "Checkpoint pendingTranscript must be a string." };
  }
  if (input.lastSavedAt + SERIALIZATION_TOLERANCE_MS < input.startedAt) {
    return { error: "Checkpoint lastSavedAt cannot be before startedAt." };
  }
  if (input.pausedTotal > Math.max(0, input.lastSavedAt - input.startedAt) + SERIALIZATION_TOLERANCE_MS) {
    return { error: "Checkpoint pausedTotal is inconsistent with its saved time." };
  }
  if (input.phase === "blocked" && input.pauseStartedAt === null) {
    return { error: "A blocked checkpoint requires pauseStartedAt." };
  }
  if (input.phase !== "blocked" && input.pauseStartedAt !== null) {
    return { error: "Only a blocked checkpoint may include pauseStartedAt." };
  }
  if (input.pauseStartedAt !== null) {
    if (input.pauseStartedAt + SERIALIZATION_TOLERANCE_MS < input.startedAt) {
      return { error: "Checkpoint pauseStartedAt cannot be before startedAt." };
    }
    if (input.pauseStartedAt > input.lastSavedAt + SERIALIZATION_TOLERANCE_MS) {
      return { error: "Checkpoint pauseStartedAt cannot be after lastSavedAt." };
    }
  }
  const completedThrough = input.pauseStartedAt === null ? input.lastSavedAt : input.pauseStartedAt;
  const maximumElapsed = Math.max(0, completedThrough - input.startedAt - input.pausedTotal);
  if (input.elapsedMs > maximumElapsed + SERIALIZATION_TOLERANCE_MS) {
    return { error: "Checkpoint elapsedMs is inconsistent with its saved timing." };
  }

  const checkpoint = clone(input);
  checkpoint.caseId = code;
  checkpoint.sessionToken = sessionToken;
  checkpoint.sessionGeneration = expectedGeneration;
  checkpoint.startedAt = expectedStartedAt;
  checkpoint.pendingTranscript = String(checkpoint.pendingTranscript || "");
  return { checkpoint };
}

export function saveCheckpoint({ code, ownerId, checkpoint, nowMs = Date.now() }) {
  return db.transaction(() => {
    const currentCode = db.prepare("SELECT status, session_owner_id FROM codes WHERE code = ?").get(code);
    if (!currentCode) return { status: "unknown", accepted: false };
    if (!safeEqual(currentCode.session_owner_id, ownerId)) return { status: currentCode.status, accepted: false, ownerMismatch: true };
    if (currentCode.status !== "active") return { status: currentCode.status, accepted: false };

    const current = checkpointRow(code);
    if (current && checkpoint.revision <= current.revision) {
      return { status: "active", accepted: false, checkpointRow: current };
    }
    const storedCheckpoint = { ...checkpoint };
    if (current) {
      for (const [field, column] of [
        ["elapsedMs", "elapsed_ms"],
        ["pausedTotal", "paused_total_ms"],
        ["lastSavedAt", "last_saved_at_ms"],
      ]) {
        const previous = Number(current[column]);
        if (storedCheckpoint[field] + MONOTONIC_TOLERANCE_MS < previous) {
          return {
            status: "active",
            accepted: false,
            error: `Checkpoint ${field} cannot move backward.`,
            checkpointRow: current,
          };
        }
        if (storedCheckpoint[field] < previous) storedCheckpoint[field] = previous;
      }
      if (
        current.phase === "blocked" &&
        storedCheckpoint.phase === "blocked" &&
        storedCheckpoint.pauseStartedAt + MONOTONIC_TOLERANCE_MS < current.pause_started_at_ms
      ) {
        return {
          status: "active",
          accepted: false,
          error: "Checkpoint pauseStartedAt cannot move backward during the same pause.",
          checkpointRow: current,
        };
      }
    }
    db.prepare(`
      INSERT INTO session_checkpoints (
        code, owner_id, checkpoint_json, revision, started_at_ms,
        paused_total_ms, pause_started_at_ms, last_saved_at_ms,
        elapsed_ms, phase, received_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        owner_id = excluded.owner_id,
        checkpoint_json = excluded.checkpoint_json,
        revision = excluded.revision,
        started_at_ms = excluded.started_at_ms,
        paused_total_ms = excluded.paused_total_ms,
        pause_started_at_ms = excluded.pause_started_at_ms,
        last_saved_at_ms = excluded.last_saved_at_ms,
        elapsed_ms = excluded.elapsed_ms,
        phase = excluded.phase,
        received_at_ms = excluded.received_at_ms
    `).run(
      code,
      ownerId,
      JSON.stringify(storedCheckpoint),
      storedCheckpoint.revision,
      storedCheckpoint.startedAt,
      storedCheckpoint.pausedTotal,
      storedCheckpoint.pauseStartedAt,
      storedCheckpoint.lastSavedAt,
      storedCheckpoint.elapsedMs,
      storedCheckpoint.phase,
      nowMs
    );
    return { status: "active", accepted: true, checkpointRow: checkpointRow(code) };
  })();
}

function pauseUsedAtReceipt(row) {
  let used = Math.max(0, Number(row?.paused_total_ms) || 0);
  if (row?.phase === "blocked" && row.pause_started_at_ms !== null) {
    used += Math.max(0, Number(row.last_saved_at_ms) - Number(row.pause_started_at_ms));
  }
  return used;
}

export function pauseDeadline(row) {
  if (!row) return null;
  return Number(row.received_at_ms) + Math.max(0, PAUSE_LIMIT_MS - pauseUsedAtReceipt(row));
}

export function checkpointTiming(row, nowMs = Date.now()) {
  if (!row) return { serverNow: nowMs, checkpointReceivedAt: null, pauseDeadlineAt: null };
  return {
    serverNow: nowMs,
    checkpointReceivedAt: Number(row.received_at_ms),
    pauseDeadlineAt: pauseDeadline(row),
  };
}

export function candidateForPayload(codeRow) {
  let portfolio = [];
  try { portfolio = JSON.parse(codeRow.candidate_portfolio || "[]"); } catch { /* keep empty */ }
  return {
    name: codeRow.candidate_name || null,
    linkedinProfile: codeRow.candidate_linkedin || null,
    email: codeRow.candidate_email || null,
    upworkProfile: codeRow.candidate_upwork || null,
    portfolio,
  };
}

export function writePayload(code, payload) {
  const dir = caseDir(code);
  const target = path.join(dir, "payload.json");
  const temporary = path.join(dir, `.payload-${process.pid}-${crypto.randomBytes(8).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), { flag: "wx" });
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function payloadFromCheckpoint(codeRow, row, reason, nowMs) {
  const checkpoint = checkpointValue(row) || {};
  const payload = clone(checkpoint);
  delete payload.sessionToken;
  const elapsedMs = Math.max(0, Number(row.elapsed_ms) || 0);
  const log = Array.isArray(payload.log) ? payload.log.filter((event) => event?.type !== "end") : [];
  const pending = String(payload.pendingTranscript || "").trim();
  if (pending && !log.some((event) => event?.type === "voice" && event.text === pending)) {
    log.push({ type: "voice", text: pending, interim: true, t: Math.floor(elapsedMs / 1000) });
  }
  log.push({ type: "end", reason, t: Math.floor(elapsedMs / 1000) });
  payload.caseId = codeRow.code;
  payload.sessionGeneration = sessionGeneration(codeRow);
  payload.startedAt = startedAtMs(codeRow);
  payload.elapsedMs = elapsedMs;
  payload.pausedTotal = reason === "pause_limit"
    ? Math.max(PAUSE_LIMIT_MS, Number(payload.pausedTotal) || 0)
    : Math.max(0, Number(payload.pausedTotal) || 0);
  payload.pauseStartedAt = null;
  payload.pendingTranscript = "";
  payload.phase = "submitted";
  payload.done = true;
  payload.doneReason = reason;
  payload.log = log;
  payload._receivedAt = isoAt(nowMs);
  payload._finalizedByServer = true;
  payload.candidate = candidateForPayload(codeRow);
  return payload;
}

export function finalizeCheckpointSession(code, reason, nowMs = Date.now()) {
  if (reason !== "pause_limit" && reason !== "expired") {
    throw new Error(`unsupported server finalization reason: ${reason}`);
  }
  return db.transaction(() => {
    const codeRow = db.prepare("SELECT * FROM codes WHERE code = ?").get(code);
    if (!codeRow || codeRow.status !== "active" || !codeRow.session_owner_id) return null;
    const row = checkpointRow(code);
    if (!row || !safeEqual(row.owner_id, codeRow.session_owner_id)) return null;
    const updated = db.prepare(`
      UPDATE codes SET status = 'submitted', submitted_at = ?, end_reason = ?, final_revision = ?
      WHERE code = ? AND status = 'active' AND session_owner_id = ?
    `).run(isoAt(nowMs), reason, row.revision, code, codeRow.session_owner_id);
    if (updated.changes !== 1) return null;
    const payload = payloadFromCheckpoint(codeRow, row, reason, nowMs);
    writePayload(code, payload);
    console.log(`checkpoint finalized: ${code} (${reason}, ${(payload.log || []).length} events)`);
    return { code, reason, payload };
  })();
}

export function sweepExpiredSessions(nowMs = Date.now()) {
  const rows = db.prepare(`
    SELECT cp.*, c.assessment_snapshot
    FROM session_checkpoints cp
    JOIN codes c ON c.code = cp.code
    WHERE c.status = 'active' AND c.session_owner_id = cp.owner_id
  `).all();
  const finalized = [];
  for (const row of rows) {
    const snapshot = parseJson(row.assessment_snapshot);
    const durationMs = Number(snapshot?.durationSeconds) * 1000;
    let reason = null;
    if (Number.isFinite(durationMs) && durationMs > 0 && row.elapsed_ms >= durationMs) {
      reason = "expired";
    } else if (pauseDeadline(row) <= nowMs) {
      reason = "pause_limit";
    }
    if (!reason) continue;
    const result = finalizeCheckpointSession(row.code, reason, nowMs);
    if (result) finalized.push(result);
  }
  return finalized;
}

export function startSessionSweeper(intervalMs = 2_000) {
  try { sweepExpiredSessions(); }
  catch (error) { console.error(`assessment session sweep failed: ${error.message}`); }
  const timer = setInterval(() => {
    try { sweepExpiredSessions(); }
    catch (error) { console.error(`assessment session sweep failed: ${error.message}`); }
  }, intervalMs);
  timer.unref?.();
  return timer;
}
