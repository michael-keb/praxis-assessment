import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ARCHIVES_DIR, SUBMISSIONS_DIR, db, getCode } from "./db.js";
import { checkpointRow, sessionGeneration } from "./assessment-session.js";

const RESET_STATUSES = new Set(["unused", "active", "submitted", "void"]);
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class SessionResetError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "SessionResetError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function validateResetRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SessionResetError(400, "invalid_reset_request", "A JSON reset request is required.");
  }
  const { requestId, expectedGeneration, expectedStatus } = body;
  if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
    throw new SessionResetError(
      400,
      "invalid_reset_request_id",
      "requestId must be a 1–128 character identifier using letters, numbers, dot, underscore, colon, or hyphen."
    );
  }
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
    throw new SessionResetError(
      400,
      "invalid_expected_generation",
      "expectedGeneration must be a non-negative integer."
    );
  }
  if (expectedStatus !== undefined && !RESET_STATUSES.has(expectedStatus)) {
    throw new SessionResetError(
      400,
      "invalid_expected_status",
      "expectedStatus must be unused, active, submitted, or void."
    );
  }
  return { requestId, expectedGeneration, expectedStatus };
}

function archiveIdFor(row, requestId, resetAt) {
  const timestamp = resetAt.replace(/[-:.TZ]/g, "");
  const digest = crypto.createHash("sha256").update(requestId).digest("hex").slice(0, 12);
  return `generation-${sessionGeneration(row)}-${timestamp}-${digest}`;
}

function writeJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function prepareArchive({ row, checkpoint, archiveId, resetRecord }) {
  const liveDir = path.join(SUBMISSIONS_DIR, row.code);
  const archiveParent = path.join(ARCHIVES_DIR, row.code);
  const archiveDir = path.join(archiveParent, archiveId);
  if (fs.existsSync(archiveDir)) {
    throw new SessionResetError(
      409,
      "reset_archive_conflict",
      "The evidence archive for this reset already exists; no data was changed."
    );
  }

  fs.mkdirSync(archiveParent, { recursive: true });
  const hadLiveDir = fs.existsSync(liveDir);
  if (hadLiveDir) fs.renameSync(liveDir, archiveDir);
  else fs.mkdirSync(archiveDir);

  let metadataCreated = false;
  try {
    fs.mkdirSync(liveDir);
    writeJson(path.join(liveDir, ".reset-in-progress.json"), {
      requestId: resetRecord.requestId,
      archiveId,
    });
    const metadataDir = path.join(archiveDir, "_reset");
    fs.mkdirSync(metadataDir);
    metadataCreated = true;
    writeJson(path.join(metadataDir, "code-record.json"), row);
    writeJson(path.join(metadataDir, "checkpoint-record.json"), checkpoint);
    writeJson(path.join(metadataDir, "reset-record.json"), resetRecord);
  } catch (error) {
    try {
      fs.rmSync(liveDir, { recursive: true, force: true });
      if (hadLiveDir) {
        fs.renameSync(archiveDir, liveDir);
        if (metadataCreated) fs.rmSync(path.join(liveDir, "_reset"), { recursive: true, force: true });
      }
      else fs.rmSync(archiveDir, { recursive: true, force: true });
    } catch (rollbackError) {
      throw new SessionResetError(
        500,
        "reset_rollback_failed",
        "The reset failed. Previous evidence is retained in the reset archive, but an admin must restore it before retrying.",
        { archiveId, cause: rollbackError.message }
      );
    }
    throw error;
  }

  return { liveDir, archiveDir, archiveParent, hadLiveDir };
}

function finishArchive(state, committed) {
  if (!state) return;
  if (committed) {
    try { fs.unlinkSync(path.join(state.liveDir, ".reset-in-progress.json")); }
    catch (error) { console.error(`reset marker cleanup failed ${state.liveDir}: ${error.message}`); }
    return;
  }

  try {
    fs.rmSync(state.liveDir, { recursive: true, force: true });
    if (state.hadLiveDir) {
      fs.renameSync(state.archiveDir, state.liveDir);
      try { fs.rmSync(path.join(state.liveDir, "_reset"), { recursive: true, force: true }); }
      catch { /* archive metadata is harmless if cleanup is interrupted */ }
    } else {
      fs.rmSync(state.archiveDir, { recursive: true, force: true });
    }
    try { fs.rmdirSync(state.archiveParent); } catch { /* other archives or already absent */ }
  } catch (error) {
    throw new SessionResetError(
      500,
      "reset_rollback_failed",
      "The reset failed. Previous evidence is retained in the reset archive, but an admin must restore it before retrying.",
      { archiveId: path.basename(state.archiveDir), cause: error.message }
    );
  }
}

function resetSummary(record) {
  return {
    requestId: record.request_id,
    fromGeneration: record.from_generation,
    toGeneration: record.to_generation,
    fromStatus: record.from_status,
    archiveId: record.archive_id,
    resetAt: record.reset_at,
  };
}

export function listSessionResets(code) {
  return db.prepare(`
    SELECT request_id, from_generation, to_generation, from_status, archive_id, reset_at
    FROM session_resets WHERE code = ? ORDER BY to_generation DESC
  `).all(code).map(resetSummary);
}

export function resetAssessmentCode(code, request) {
  const { requestId, expectedGeneration, expectedStatus } = validateResetRequest(request);
  let fsState = null;
  let committed = false;
  try {
    const result = db.transaction(() => {
      /* Acquire SQLite's write lock before moving any evidence on disk. */
      db.prepare("UPDATE codes SET session_generation = session_generation WHERE code = ?").run(code);

      const prior = db.prepare("SELECT * FROM session_resets WHERE request_id = ?").get(requestId);
      if (prior) {
        if (prior.code !== code) {
          throw new SessionResetError(
            409,
            "reset_request_id_conflict",
            "That requestId was already used to reset a different code."
          );
        }
        const archiveDir = path.join(ARCHIVES_DIR, code, prior.archive_id);
        if (!fs.existsSync(archiveDir)) {
          throw new SessionResetError(
            500,
            "reset_archive_missing",
            "The reset was recorded, but its evidence archive is missing."
          );
        }
        return { idempotent: true, code: getCode(code), reset: resetSummary(prior) };
      }

      const row = getCode(code);
      if (!row) throw new SessionResetError(404, "unknown_code", "Unknown assessment code.");
      const actualGeneration = sessionGeneration(row);
      if (actualGeneration !== expectedGeneration) {
        throw new SessionResetError(
          409,
          "reset_generation_conflict",
          "The code changed after it was reviewed; reload its current state before resetting.",
          { expectedGeneration, actualGeneration, actualStatus: row.status }
        );
      }
      if (expectedStatus !== undefined && row.status !== expectedStatus) {
        throw new SessionResetError(
          409,
          "reset_status_conflict",
          "The code status changed after it was reviewed; reload its current state before resetting.",
          { expectedStatus, actualStatus: row.status, actualGeneration }
        );
      }

      const checkpoint = checkpointRow(code);
      const resetAt = new Date().toISOString();
      const toGeneration = actualGeneration + 1;
      const archiveId = archiveIdFor(row, requestId, resetAt);
      const resetRecord = {
        requestId,
        code,
        fromGeneration: actualGeneration,
        toGeneration,
        fromStatus: row.status,
        resetAt,
        archiveId,
      };
      fsState = prepareArchive({ row, checkpoint, archiveId, resetRecord });

      db.prepare(`
        INSERT INTO session_resets (
          request_id, code, from_generation, to_generation, from_status,
          archive_id, reset_at, code_record_json, checkpoint_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        code,
        actualGeneration,
        toGeneration,
        row.status,
        archiveId,
        resetAt,
        JSON.stringify(row),
        checkpoint ? JSON.stringify(checkpoint) : null
      );

      const updated = db.prepare(`
        UPDATE codes SET
          status = 'unused',
          user_id = NULL,
          started_at = NULL,
          submitted_at = NULL,
          end_reason = NULL,
          candidate_name = NULL,
          candidate_email = NULL,
          candidate_upwork = NULL,
          candidate_linkedin = NULL,
          candidate_cv = NULL,
          candidate_portfolio = NULL,
          session_owner_id = NULL,
          assessment_snapshot = NULL,
          started_at_ms = NULL,
          final_revision = NULL,
          session_generation = ?,
          last_reset_request_id = ?,
          reset_at = ?
        WHERE code = ? AND session_generation = ? AND status = ?
      `).run(toGeneration, requestId, resetAt, code, actualGeneration, row.status);
      if (updated.changes !== 1) {
        throw new SessionResetError(
          409,
          "reset_state_conflict",
          "The code changed while the reset was being applied; no data was changed."
        );
      }
      db.prepare("DELETE FROM session_checkpoints WHERE code = ?").run(code);
      return { idempotent: false, code: getCode(code), reset: resetRecord };
    })();
    committed = true;
    finishArchive(fsState, true);
    return result;
  } catch (error) {
    try { finishArchive(fsState, committed); }
    catch (rollbackError) { throw rollbackError; }
    throw error;
  }
}
