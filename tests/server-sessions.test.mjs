import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import jwt from "jsonwebtoken";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
let dataDir;
let port;
let baseUrl;
let server;
let serverOutput = "";
let adminCookie;
let db;
let sweepExpiredSessions;

async function unusedPort() {
  return await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const selected = socket.address().port;
      socket.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

async function launchServer() {
  serverOutput = "";
  server = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ASSESSMENT_PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_EMAIL: "sessions@example.test",
      ADMIN_PASSWORD: "sessions-local-only",
      JWT_SECRET: "sessions-local-jwt-only",
      ASSEMBLYAI_API_KEY: "",
      EXTENSION_API_KEY: "sessions-extension-key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`server did not become healthy:\n${serverOutput}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await exited;
}

async function request(pathname, { method = "GET", body, headers = {}, admin = false } = {}) {
  const options = { method, headers: { ...headers }, signal: AbortSignal.timeout(5_000) };
  if (admin) options.headers.Cookie = adminCookie;
  if (body !== undefined) {
    if (body instanceof FormData) {
      options.body = body;
    } else {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
  }
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON response */ }
  return { status: response.status, body: json, text, headers: response.headers };
}

async function login() {
  const response = await request("/api/auth/login", {
    method: "POST",
    body: { email: "sessions@example.test", password: "sessions-local-only" },
  });
  assert.equal(response.status, 200, response.text);
  adminCookie = response.headers.get("set-cookie").split(";", 1)[0];
}

async function createAssessment({
  title = "Server session test",
  brief = "Use the immutable test brief.",
  durationMinutes = 15,
  requireLinkedin = false,
  requireUpwork = false,
  requireCv = false,
  requirePortfolio = false,
} = {}) {
  const response = await request("/api/admin/assessments", {
    admin: true,
    method: "POST",
    body: { title, brief, durationMinutes, requireLinkedin, requireUpwork, requireCv, requirePortfolio },
  });
  assert.equal(response.status, 200, response.text);
  return response.body.assessment;
}

async function updateAssessment(id, values) {
  const response = await request(`/api/admin/assessments/${id}`, {
    admin: true,
    method: "PUT",
    body: values,
  });
  assert.equal(response.status, 200, response.text);
  return response.body.assessment;
}

async function issueCode(assessmentId) {
  const response = await request("/api/admin/codes", {
    admin: true,
    method: "POST",
    body: assessmentId === undefined ? { count: 1 } : { count: 1, assessmentId },
  });
  assert.equal(response.status, 200, response.text);
  return response.body.codes[0];
}

async function session(code, token) {
  return request(`/api/assessment/session?case=${encodeURIComponent(code)}`, {
    headers: token ? { "X-Assessment-Session": token } : {},
  });
}

async function start(code, token, details = {}) {
  return request("/api/assessment/start", {
    method: "POST",
    headers: { "X-Assessment-Session": token },
    body: { caseId: code, sessionToken: token, name: "Session Owner", ...details },
  });
}

function checkpointBody(code, token, startedAt, overrides = {}) {
  return {
    caseId: code,
    sessionToken: token,
    startedAt,
    pausedTotal: 0,
    pauseStartedAt: null,
    lastSavedAt: startedAt + 1_000,
    log: [],
    revision: 1,
    phase: "running",
    elapsedMs: 1_000,
    pendingTranscript: "",
    zones: { 1: "draft" },
    confidence: 3,
    ...overrides,
  };
}

async function checkpoint(body, token = body.sessionToken) {
  return request("/api/assessment/checkpoint", {
    method: "POST",
    headers: { "X-Assessment-Session": token },
    body,
  });
}

async function review(code) {
  return request(`/api/admin/sessions/${code}`, { admin: true });
}

async function resetCode(code, body) {
  return request(`/api/admin/codes/${code}/reset`, { admin: true, method: "POST", body });
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "praxis-server-sessions-"));
  port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    JWT_SECRET: "sessions-local-jwt-only",
  });
  ({ db } = await import("../server/db.js"));
  ({ sweepExpiredSessions } = await import("../server/assessment-session.js"));
  await launchServer();
  await login();
});

after(async () => {
  await stopServer();
  try { db.close(); } catch { /* already closed */ }
  rmSync(dataDir, { recursive: true, force: true });
});

test("unused codes receive unique signed tokens, default metadata, and cannot submit before start", async () => {
  const code = await issueCode();
  const first = await session(code);
  const second = await session(code);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "unused");
  assert.equal(first.body.sessionGeneration, 0);
  assert.deepEqual(first.body.assessment, {
    title: "Assessment",
    durationSeconds: 900,
    gateFields: { linkedin: true, upwork: false, cv: false, portfolio: false },
  });
  assert.equal(Object.hasOwn(first.body.assessment, "brief"), false);
  assert.equal(typeof first.body.sessionToken, "string");
  assert.notEqual(first.body.sessionToken, second.body.sessionToken);

  const premature = await request("/api/assessment", {
    method: "POST",
    headers: { "X-Assessment-Session": first.body.sessionToken },
    body: { caseId: code, sessionToken: first.body.sessionToken, revision: 1, log: [] },
  });
  assert.equal(premature.status, 409);
  assert.equal(premature.body.code, "session_not_started");

  const started = await start(code, first.body.sessionToken, {
    linkedin: "https://www.linkedin.com/in/session-owner",
  });
  assert.equal(started.status, 200, started.text);
  assert.deepEqual(started.body.assessment, {
    title: "Assessment",
    brief: "",
    durationSeconds: 900,
    gateFields: { linkedin: true, upwork: false, cv: false, portfolio: false },
  });
  assert.equal(Number.isSafeInteger(started.body.startedAt), true);
  assert.equal(started.body.checkpoint.revision, 0);
  assert.equal(started.body.checkpoint.sessionToken, first.body.sessionToken);
  assert.equal(started.body.sessionGeneration, 0);
  assert.equal(started.body.checkpoint.sessionGeneration, 0);
});

test("protected routes reject a missing token promptly", async () => {
  const assessment = await createAssessment({ title: "Missing token test" });
  const code = await issueCode(assessment.id);
  const issued = await session(code);
  const token = issued.body.sessionToken;

  const missingStart = await request("/api/assessment/start", {
    method: "POST",
    body: { caseId: code, name: "No token" },
  });
  assert.equal(missingStart.status, 403);
  assert.equal(missingStart.body.code, "invalid_session_token");

  const missingPreflight = await request("/api/assessment/transcribe-token", {
    method: "POST",
    body: { caseId: code },
  });
  assert.equal(missingPreflight.status, 403);
  const missingPrematureFinal = await request("/api/assessment", {
    method: "POST",
    body: { caseId: code, log: [] },
  });
  assert.equal(missingPrematureFinal.status, 403);

  const started = await start(code, token);
  assert.equal(started.status, 200, started.text);
  const missingCheckpoint = await request("/api/assessment/checkpoint", {
    method: "POST",
    body: checkpointBody(code, "", started.body.startedAt),
  });
  assert.equal(missingCheckpoint.status, 403);
  const missingFinal = await request("/api/assessment", {
    method: "POST",
    body: { caseId: code, revision: 2, log: [] },
  });
  assert.equal(missingFinal.status, 403);
  const missingActivePreflight = await request("/api/assessment/transcribe-token", {
    method: "POST",
    body: { caseId: code },
  });
  assert.equal(missingActivePreflight.status, 403);

  const frame = new FormData();
  frame.append("caseId", code);
  frame.append("frames", new Blob(["synthetic jpeg bytes"], { type: "image/jpeg" }), "f_1.jpg");
  const missingUpload = await request("/api/assessment/frames", { method: "POST", body: frame });
  assert.equal(missingUpload.status, 403);
  assert.equal(missingUpload.body.code, "invalid_session_token");
});

test("the first start binds atomically, retries idempotently, and freezes the assessment", async () => {
  const assessment = await createAssessment({
    title: "Original title",
    brief: "Original brief",
    durationMinutes: 15,
  });
  const code = await issueCode(assessment.id);
  const ownerToken = (await session(code)).body.sessionToken;
  const contenderToken = (await session(code)).body.sessionToken;
  const first = await start(code, ownerToken, { name: "Original candidate" });
  assert.equal(first.status, 200, first.text);

  const retry = await request("/api/assessment/start", {
    method: "POST",
    headers: { "X-Assessment-Session": ownerToken },
    body: { caseId: code, sessionToken: ownerToken },
  });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.body.startedAt, first.body.startedAt);
  assert.deepEqual(retry.body.assessment, first.body.assessment);

  await updateAssessment(assessment.id, {
    title: "Edited title",
    brief: "Edited brief",
    durationMinutes: 1,
    requireLinkedin: true,
    requireUpwork: true,
    requireCv: false,
    requirePortfolio: false,
  });
  const ownerView = await session(code, ownerToken);
  assert.equal(ownerView.body.owned, true);
  assert.equal(ownerView.body.assessment.title, "Original title");
  assert.equal(ownerView.body.assessment.brief, "Original brief");
  assert.equal(ownerView.body.assessment.durationSeconds, 900);
  assert.deepEqual(ownerView.body.assessment.gateFields, {
    linkedin: false, upwork: false, cv: false, portfolio: false,
  });

  const outsiderView = await session(code, contenderToken);
  assert.equal(outsiderView.body.owned, false);
  assert.equal(Object.hasOwn(outsiderView.body.assessment, "brief"), false);
  assert.equal(Object.hasOwn(outsiderView.body, "checkpoint"), false);
  assert.equal(Object.hasOwn(outsiderView.body, "candidateName"), false);
  const rejected = await start(code, contenderToken, {
    name: "Competing candidate",
    linkedin: "https://linkedin.com/in/competing",
    upwork: "https://upwork.com/freelancers/competing",
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, "session_owner_mismatch");

  const raceAssessment = await createAssessment({ title: "Race", brief: "Race brief" });
  const raceCode = await issueCode(raceAssessment.id);
  const leftToken = (await session(raceCode)).body.sessionToken;
  const rightToken = (await session(raceCode)).body.sessionToken;
  const [left, right] = await Promise.all([
    start(raceCode, leftToken, { name: "Left candidate" }),
    start(raceCode, rightToken, { name: "Right candidate" }),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 409]);
  const winner = left.status === 200 ? leftToken : rightToken;
  const loser = left.status === 200 ? rightToken : leftToken;
  assert.equal((await session(raceCode, winner)).body.owned, true);
  assert.equal((await session(raceCode, loser)).body.owned, false);
});

test("checkpoints are durable, owner-only, revision ordered, and visible to admins without the bearer token", async () => {
  const assessment = await createAssessment({ title: "Checkpoint test" });
  const code = await issueCode(assessment.id);
  const ownerToken = (await session(code)).body.sessionToken;
  const contenderToken = (await session(code)).body.sessionToken;
  const started = await start(code, ownerToken);
  const newest = checkpointBody(code, ownerToken, started.body.startedAt, {
    revision: 3,
    pausedTotal: 100,
    log: [{ type: "voice", text: "newest finalized words", t: 1 }],
    pendingTranscript: "newest interim words",
    phase: "blocked",
    pauseStartedAt: started.body.startedAt + 900,
  });
  const saved = await checkpoint(newest);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.accepted, true);
  assert.equal(saved.body.revision, 3);
  assert.equal(Number.isSafeInteger(saved.body.checkpointReceivedAt), true);
  assert.equal(saved.body.pauseDeadlineAt > saved.body.checkpointReceivedAt, true);

  const older = await checkpoint(checkpointBody(code, ownerToken, started.body.startedAt, {
    revision: 2,
    log: [{ type: "voice", text: "stale words", t: 1 }],
  }));
  assert.equal(older.status, 200, older.text);
  assert.equal(older.body.accepted, false);
  assert.equal(older.body.revision, 3);

  const elapsedRegression = await checkpoint({
    ...newest,
    revision: 4,
    elapsedMs: newest.elapsedMs - 100,
    lastSavedAt: newest.lastSavedAt + 100,
  });
  assert.equal(elapsedRegression.status, 400);
  assert.equal(elapsedRegression.body.code, "checkpoint_time_regression");
  const pausedRegression = await checkpoint({
    ...newest,
    revision: 4,
    pausedTotal: 0,
    lastSavedAt: newest.lastSavedAt + 100,
  });
  assert.equal(pausedRegression.status, 400);
  assert.equal(pausedRegression.body.code, "checkpoint_time_regression");
  const incoherentPause = await checkpoint({
    ...newest,
    revision: 4,
    pauseStartedAt: newest.lastSavedAt + 4_000,
  });
  assert.equal(incoherentPause.status, 400);
  assert.match(incoherentPause.body.error, /pauseStartedAt.*after lastSavedAt/i);

  const ownerView = await session(code, ownerToken);
  assert.equal(ownerView.body.checkpoint.revision, 3);
  assert.equal(ownerView.body.checkpoint.pendingTranscript, "newest interim words");
  assert.equal(ownerView.body.checkpoint.sessionToken, ownerToken);

  const outsider = await checkpoint({ ...newest, revision: 4, sessionToken: contenderToken }, contenderToken);
  assert.equal(outsider.status, 409);
  assert.equal(outsider.body.code, "session_owner_mismatch");

  const admin = await review(code);
  assert.equal(admin.status, 200, admin.text);
  assert.equal(admin.body.payload, null);
  assert.equal(admin.body.checkpoint.revision, 3);
  assert.equal(admin.body.checkpoint.pendingTranscript, "newest interim words");
  assert.equal(Object.hasOwn(admin.body.checkpoint, "sessionToken"), false);
});

test("only the owner can submit or upload, late owned uploads work, and explicit duplicate finals do not overwrite", async () => {
  const assessment = await createAssessment({ title: "Submission test" });
  const code = await issueCode(assessment.id);
  const ownerToken = (await session(code)).body.sessionToken;
  const contenderToken = (await session(code)).body.sessionToken;
  const started = await start(code, ownerToken, { name: "Stored identity" });
  await checkpoint(checkpointBody(code, ownerToken, started.body.startedAt));

  const rejected = await request("/api/assessment", {
    method: "POST",
    headers: { "X-Assessment-Session": contenderToken },
    body: {
      ...checkpointBody(code, contenderToken, started.body.startedAt, { revision: 2 }),
      log: [{ type: "end", reason: "submitted", t: 1 }],
    },
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, "session_owner_mismatch");

  const final = {
    ...checkpointBody(code, ownerToken, started.body.startedAt, { revision: 2 }),
    log: [
      { type: "voice", text: "the stored answer", t: 1 },
      { type: "end", reason: "submitted", t: 2 },
    ],
  };
  const accepted = await request("/api/assessment", {
    method: "POST",
    headers: { "X-Assessment-Session": ownerToken },
    body: final,
  });
  assert.equal(accepted.status, 200, accepted.text);
  assert.equal(accepted.body.acknowledged, true);
  assert.equal(accepted.body.duplicate, false);

  const duplicate = await request("/api/assessment", {
    method: "POST",
    headers: { "X-Assessment-Session": ownerToken },
    body: {
      ...final,
      revision: 99,
      log: [{ type: "voice", text: "must not overwrite" }, { type: "end", reason: "expired" }],
    },
  });
  assert.equal(duplicate.status, 200, duplicate.text);
  assert.equal(duplicate.body.duplicate, true);

  const frame = new FormData();
  frame.append("caseId", code);
  frame.append("sessionToken", ownerToken);
  frame.append("frames", new Blob(["synthetic jpeg bytes"], { type: "image/jpeg" }), "f_2.jpg");
  const frameSaved = await request("/api/assessment/frames", {
    method: "POST",
    headers: { "X-Assessment-Session": ownerToken },
    body: frame,
  });
  assert.equal(frameSaved.status, 200, frameSaved.text);
  assert.equal(frameSaved.body.status, "submitted");
  assert.equal(frameSaved.body.saved, 1);

  const badFrame = new FormData();
  badFrame.append("caseId", code);
  badFrame.append("sessionToken", contenderToken);
  badFrame.append("frames", new Blob(["other bytes"], { type: "image/jpeg" }), "f_3.jpg");
  const frameRejected = await request("/api/assessment/frames", {
    method: "POST",
    headers: { "X-Assessment-Session": contenderToken },
    body: badFrame,
  });
  assert.equal(frameRejected.status, 409);

  const admin = await review(code);
  assert.equal(admin.body.payload.log[0].text, "the stored answer");
  assert.equal(admin.body.payload.log.some((event) => event.text === "must not overwrite"), false);
  assert.equal(Object.hasOwn(admin.body.payload, "sessionToken"), false);
  assert.deepEqual(admin.body.frames, ["f_2.jpg"]);
  assert.equal((await session(code, ownerToken)).body.owned, true);
  assert.equal((await session(code, contenderToken)).body.owned, false);
});

test("reported duration expiry finalizes once and reconciles only newer late evidence", async () => {
  const assessment = await createAssessment({ title: "Duration test", durationMinutes: 1 });
  const code = await issueCode(assessment.id);
  const token = (await session(code)).body.sessionToken;
  const started = await start(code, token);
  const expiring = checkpointBody(code, token, started.body.startedAt, {
    revision: 5,
    elapsedMs: 60_000,
    lastSavedAt: started.body.startedAt + 60_000,
    log: [{ type: "voice", text: "before cutoff", t: 58 }, { type: "end", reason: "submitted", t: 60 }],
    pendingTranscript: "words at the cutoff",
    phase: "submitting",
  });
  const saved = await checkpoint(expiring);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.status, "submitted");
  assert.equal(saved.body.endReason, "expired");

  let admin = await review(code);
  assert.equal(admin.body.payload._finalizedByServer, true);
  assert.equal(admin.body.payload.doneReason, "expired");
  assert.equal(admin.body.payload.log.filter((event) => event.type === "end").length, 1);
  assert.equal(admin.body.payload.log.at(-1).reason, "expired");
  assert.equal(admin.body.payload.log.some((event) => event.interim && event.text === "words at the cutoff"), true);

  const staleFinal = await request("/api/assessment", {
    method: "POST",
    headers: { "X-Assessment-Session": token },
    body: expiring,
  });
  assert.equal(staleFinal.status, 409);
  assert.equal(staleFinal.body.code, "server_finalized");

  const newerFinal = {
    ...expiring,
    revision: 6,
    pendingTranscript: "",
    zones: { 1: "newer local draft" },
    log: [
      { type: "voice", text: "before cutoff", t: 58 },
      { type: "voice", text: "words at the cutoff", interim: true, t: 60 },
      { type: "voice", text: "arrived after server finalization", t: 60 },
      { type: "end", reason: "submitted", t: 60 },
    ],
  };
  const reconciled = await request("/api/assessment", {
    method: "POST",
    headers: { "X-Assessment-Session": token },
    body: newerFinal,
  });
  assert.equal(reconciled.status, 200, reconciled.text);
  assert.equal(reconciled.body.reconciled, true);
  assert.equal(reconciled.body.endReason, "expired");

  admin = await review(code);
  assert.equal(admin.body.code.end_reason, "expired");
  assert.equal(admin.body.payload.zones[1], "newer local draft");
  assert.equal(admin.body.payload.log.at(-1).reason, "expired");
  assert.equal(admin.body.payload.log.filter((event) => event.type === "end").length, 1);
  assert.equal(admin.body.payload.log.some((event) => event.text === "arrived after server finalization" && event.late), true);
  assert.equal(admin.body.payload.log.filter((event) => event.text === "words at the cutoff").length, 1);
  assert.equal(admin.body.payload._lateEvidence.at(-1).revision, 6);

  const retry = await request("/api/assessment", {
    method: "POST",
    headers: { "X-Assessment-Session": token },
    body: newerFinal,
  });
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.body.duplicate, true);

  const incrementedRetry = await request("/api/assessment", {
    method: "POST",
    headers: { "X-Assessment-Session": token },
    body: { ...newerFinal, revision: 7, lastSavedAt: newerFinal.lastSavedAt + 1 },
  });
  assert.equal(incrementedRetry.status, 200, incrementedRetry.text);
  assert.equal(incrementedRetry.body.reconciled, true);
  admin = await review(code);
  assert.equal(admin.body.payload.log.filter((event) => event.text === "arrived after server finalization").length, 1);
  assert.equal(admin.body.payload.log.filter((event) => event.text === "words at the cutoff").length, 1);
});

test("legacy active rows cannot be claimed by a newly issued token", async () => {
  const assessment = await createAssessment({ title: "Legacy test" });
  const code = await issueCode(assessment.id);
  const token = (await session(code)).body.sessionToken;
  const legacyStartedAt = Date.now();
  db.prepare("UPDATE codes SET status = 'active', started_at = ? WHERE code = ?")
    .run(new Date(legacyStartedAt).toISOString(), code);

  const status = await session(code, token);
  assert.equal(status.status, 200);
  assert.equal(status.body.owned, false);
  assert.equal(status.body.errorCode, "legacy_owner_unavailable");
  assert.match(status.body.recovery, /admin.*void.*new/i);
  assert.equal(Object.hasOwn(status.body, "checkpoint"), false);
  assert.equal(Object.hasOwn(status.body.assessment, "brief"), false);

  const resume = await start(code, token);
  assert.equal(resume.status, 409);
  assert.equal(resume.body.code, "legacy_owner_unavailable");
  const submit = await request("/api/assessment", {
    method: "POST",
    headers: { "X-Assessment-Session": token },
    body: { caseId: code, sessionToken: token, revision: 1, log: [] },
  });
  assert.equal(submit.status, 409);
  assert.equal(submit.body.code, "legacy_owner_unavailable");
});

test("pause-budget expiry uses the persisted receipt time and survives a server restart", async () => {
  const assessment = await createAssessment({ title: "Restart expiry test" });
  const code = await issueCode(assessment.id);
  const token = (await session(code)).body.sessionToken;
  const started = await start(code, token);
  const blocked = checkpointBody(code, token, started.body.startedAt, {
    revision: 7,
    pausedTotal: 290_000,
    pauseStartedAt: started.body.startedAt + 291_000,
    lastSavedAt: started.body.startedAt + 291_000,
    elapsedMs: 1_000,
    phase: "blocked",
    log: [{ type: "voice", text: "durable before restart", t: 1 }],
    pendingTranscript: "unfinished before close",
  });
  const saved = await checkpoint(blocked);
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.pauseDeadlineAt - saved.body.checkpointReceivedAt, 10_000);

  await stopServer();
  const finalized = sweepExpiredSessions(saved.body.checkpointReceivedAt + 10_001);
  assert.deepEqual(finalized.map((entry) => ({ code: entry.code, reason: entry.reason })), [
    { code, reason: "pause_limit" },
  ]);
  await launchServer();
  await login();

  const admin = await review(code);
  assert.equal(admin.status, 200, admin.text);
  assert.equal(admin.body.code.status, "submitted");
  assert.equal(admin.body.code.end_reason, "pause_limit");
  assert.equal(admin.body.payload._finalizedByServer, true);
  assert.equal(admin.body.payload.pausedTotal, 300_000);
  assert.equal(admin.body.payload.log.filter((event) => event.type === "end").length, 1);
  assert.equal(admin.body.payload.log.at(-1).reason, "pause_limit");
  assert.equal(admin.body.payload.log.some((event) => event.interim && event.text === "unfinished before close"), true);
  const ownerView = await session(code, token);
  assert.equal(ownerView.body.status, "submitted");
  assert.equal(ownerView.body.owned, true);
});

test("profile gates normalize bare expected hosts and reject ambiguous URLs", async () => {
  const assessment = await createAssessment({
    title: "Profile URL test",
    requireLinkedin: true,
    requireUpwork: true,
  });
  const code = await issueCode(assessment.id);
  const token = (await session(code)).body.sessionToken;
  const valid = {
    linkedin: "linkedin.com/in/example-person",
    upwork: "www.upwork.com/freelancers/example-person",
  };
  const invalid = [
    { ...valid, linkedin: "linkedin.com" },
    { ...valid, linkedin: "https://linkedin.com.evil.test/in/example-person" },
    { ...valid, linkedin: "https://attacker@linkedin.com/in/example-person" },
    { ...valid, linkedin: " linkedin.com/in/example-person" },
    { ...valid, linkedin: "ftp://linkedin.com/in/example-person" },
    { ...valid, upwork: "upwork.com" },
    { ...valid, upwork: "https://www.upwork.com.evil.test/freelancers/example-person" },
    { ...valid, upwork: "https://attacker@upwork.com/freelancers/example-person" },
    { ...valid, upwork: "www.upwork.com/freelancers/example person" },
  ];
  for (const details of invalid) {
    const rejected = await start(code, token, details);
    assert.equal(rejected.status, 400, `${JSON.stringify(details)}: ${rejected.text}`);
  }

  const accepted = await start(code, token, valid);
  assert.equal(accepted.status, 200, accepted.text);
  const admin = await review(code);
  assert.equal(admin.body.candidate.linkedin, "https://linkedin.com/in/example-person");
  assert.equal(admin.body.candidate.upwork, "https://www.upwork.com/freelancers/example-person");
});

test("guarded reset archives an owned submission, is idempotent, and invalidates old tokens", async () => {
  const assessment = await createAssessment({ title: "Owned reset test" });
  const code = await issueCode(assessment.id);
  const issued = await session(code);
  const oldToken = issued.body.sessionToken;
  const started = await start(code, oldToken, { name: "Prior candidate" });
  const saved = await checkpoint(checkpointBody(code, oldToken, started.body.startedAt, {
    revision: 4,
    log: [{ type: "voice", text: "prior durable answer", t: 1 }],
  }));
  assert.equal(saved.status, 200, saved.text);
  const final = await request("/api/assessment", {
    method: "POST",
    headers: { "X-Assessment-Session": oldToken },
    body: {
      ...checkpointBody(code, oldToken, started.body.startedAt, { revision: 5 }),
      log: [
        { type: "voice", text: "prior final answer", t: 1 },
        { type: "end", reason: "submitted", t: 2 },
      ],
    },
  });
  assert.equal(final.status, 200, final.text);
  const frame = new FormData();
  frame.append("caseId", code);
  frame.append("sessionToken", oldToken);
  frame.append("frames", new Blob(["prior frame"], { type: "image/jpeg" }), "f_9.jpg");
  assert.equal((await request("/api/assessment/frames", {
    method: "POST",
    headers: { "X-Assessment-Session": oldToken },
    body: frame,
  })).status, 200);

  const before = await review(code);
  assert.equal(before.body.code.status, "submitted");
  assert.equal(before.body.code.session_generation, 0);
  assert.equal(before.body.checkpoint.revision, 4);

  const badGeneration = await resetCode(code, {
    requestId: `wrong-generation-${code}`,
    expectedGeneration: 1,
    expectedStatus: "submitted",
  });
  assert.equal(badGeneration.status, 409);
  assert.equal(badGeneration.body.code, "reset_generation_conflict");
  const badStatus = await resetCode(code, {
    requestId: `wrong-status-${code}`,
    expectedGeneration: 0,
    expectedStatus: "active",
  });
  assert.equal(badStatus.status, 409);
  assert.equal(badStatus.body.code, "reset_status_conflict");
  assert.equal((await review(code)).body.code.status, "submitted");

  const requestId = `owned-reset-${code}`;
  const resetRequest = { requestId, expectedGeneration: 0, expectedStatus: "submitted" };
  const reset = await resetCode(code, resetRequest);
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.body.idempotent, false);
  assert.equal(reset.body.code.code, code);
  assert.equal(reset.body.code.assessment_id, assessment.id);
  assert.equal(reset.body.code.created_at, before.body.code.created_at);
  assert.equal(reset.body.code.status, "unused");
  assert.equal(reset.body.code.session_generation, 1);
  assert.equal(reset.body.code.session_owner_id, null);
  assert.equal(reset.body.code.assessment_snapshot, null);
  assert.equal(reset.body.code.final_revision, null);
  assert.equal(reset.body.code.candidate_name, null);

  const archiveDir = path.join(dataDir, "submission-archives", code, reset.body.reset.archiveId);
  assert.equal(existsSync(path.join(archiveDir, "payload.json")), true);
  assert.equal(existsSync(path.join(archiveDir, "frames", "f_9.jpg")), true);
  assert.equal(existsSync(path.join(archiveDir, "_reset", "code-record.json")), true);
  assert.equal(existsSync(path.join(archiveDir, "_reset", "checkpoint-record.json")), true);
  const archivedCode = JSON.parse(readFileSync(path.join(archiveDir, "_reset", "code-record.json"), "utf8"));
  const archivedCheckpoint = JSON.parse(readFileSync(path.join(archiveDir, "_reset", "checkpoint-record.json"), "utf8"));
  assert.equal(archivedCode.candidate_name, "Prior candidate");
  assert.equal(JSON.parse(archivedCheckpoint.checkpoint_json).log[0].text, "prior durable answer");
  assert.deepEqual(readdirSync(path.join(dataDir, "submissions", code)), []);

  const after = await review(code);
  assert.equal(after.body.candidate, null);
  assert.equal(after.body.payload, null);
  assert.equal(after.body.checkpoint, null);
  assert.deepEqual(after.body.frames, []);
  assert.equal(after.body.resets[0].requestId, requestId);

  const retry = await resetCode(code, resetRequest);
  assert.equal(retry.status, 200, retry.text);
  assert.equal(retry.body.idempotent, true);
  assert.equal(retry.body.reset.archiveId, reset.body.reset.archiveId);
  assert.equal(readdirSync(path.join(dataDir, "submission-archives", code)).length, 1);

  const staleStart = await start(code, oldToken);
  assert.equal(staleStart.status, 409);
  assert.equal(staleStart.body.code, "session_generation_mismatch");
  assert.match(`${staleStart.body.error} ${staleStart.body.recovery}`, /reload.*same.*link/i);

  const refreshed = await session(code, oldToken);
  assert.equal(refreshed.body.status, "unused");
  assert.equal(refreshed.body.sessionGeneration, 1);
  assert.notEqual(refreshed.body.sessionToken, oldToken);
  const restarted = await start(code, refreshed.body.sessionToken, { name: "New candidate" });
  assert.equal(restarted.status, 200, restarted.text);
  assert.equal(restarted.body.sessionGeneration, 1);
  assert.equal(restarted.body.checkpoint.sessionGeneration, 1);
  assert.equal((await session(code, oldToken)).body.owned, false);
  assert.equal(existsSync(path.join(archiveDir, "payload.json")), true);

  const retryAfterRestart = await resetCode(code, resetRequest);
  assert.equal(retryAfterRestart.status, 200, retryAfterRestart.text);
  assert.equal(retryAfterRestart.body.idempotent, true);
  assert.equal(retryAfterRestart.body.code.status, "active");
  assert.equal(retryAfterRestart.body.code.session_generation, 1);
  assert.equal((await session(code, refreshed.body.sessionToken)).body.owned, true);

  const anotherCode = await issueCode(assessment.id);
  const reusedRequestId = await resetCode(anotherCode, {
    requestId,
    expectedGeneration: 0,
    expectedStatus: "unused",
  });
  assert.equal(reusedRequestId.status, 409);
  assert.equal(reusedRequestId.body.code, "reset_request_id_conflict");
});

test("reset preserves a legacy submission archive while reusing the same code", async () => {
  const assessment = await createAssessment({ title: "Legacy submitted reset" });
  const code = await issueCode(assessment.id);
  const startedAt = new Date(Date.now() - 9_000).toISOString();
  db.prepare(`
    UPDATE codes SET status = 'submitted', started_at = ?, submitted_at = ?, end_reason = 'submitted',
      candidate_name = 'Legacy candidate', candidate_linkedin = 'https://linkedin.com/in/legacy'
    WHERE code = ?
  `).run(startedAt, new Date().toISOString(), code);
  const legacyDir = path.join(dataDir, "submissions", code);
  mkdirSync(path.join(legacyDir, "audio"), { recursive: true });
  writeFileSync(path.join(legacyDir, "payload.json"), JSON.stringify({
    caseId: code,
    log: [{ type: "voice", text: "legacy evidence" }],
  }));
  writeFileSync(path.join(legacyDir, "audio", "voice_1.webm"), "legacy audio");

  const reset = await resetCode(code, {
    requestId: `legacy-reset-${code}`,
    expectedGeneration: 0,
    expectedStatus: "submitted",
  });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.body.code.code, code);
  assert.equal(reset.body.code.assessment_id, assessment.id);
  assert.equal(reset.body.code.status, "unused");
  assert.equal(reset.body.code.session_generation, 1);
  const archiveDir = path.join(dataDir, "submission-archives", code, reset.body.reset.archiveId);
  assert.equal(JSON.parse(readFileSync(path.join(archiveDir, "payload.json"), "utf8")).log[0].text, "legacy evidence");
  assert.equal(readFileSync(path.join(archiveDir, "audio", "voice_1.webm"), "utf8"), "legacy audio");
  assert.equal(JSON.parse(readFileSync(path.join(archiveDir, "_reset", "code-record.json"), "utf8")).candidate_name, "Legacy candidate");
  assert.equal(JSON.parse(readFileSync(path.join(archiveDir, "_reset", "checkpoint-record.json"), "utf8")), null);
  const next = await session(code);
  assert.equal(next.body.status, "unused");
  assert.equal(next.body.sessionGeneration, 1);
});

test("deployed generation-less tokens work at generation zero and expire after reset", async () => {
  const assessment = await createAssessment({ title: "Legacy token compatibility" });
  const code = await issueCode(assessment.id);
  const ownerId = `deployed-owner-${code}-1234567890`;
  const legacyToken = jwt.sign(
    { kind: "assessment-session-v1", caseId: code, ownerId },
    "sessions-local-jwt-only",
    { algorithm: "HS256", jwtid: ownerId }
  );
  const started = await start(code, legacyToken, { name: "Generation zero owner" });
  assert.equal(started.status, 200, started.text);
  assert.equal(started.body.sessionGeneration, 0);
  assert.equal((await session(code, legacyToken)).body.owned, true);

  const reset = await resetCode(code, {
    requestId: `legacy-token-reset-${code}`,
    expectedGeneration: 0,
    expectedStatus: "active",
  });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.body.code.session_generation, 1);
  const stale = await start(code, legacyToken);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "session_generation_mismatch");
});

test("a failed reset rolls database and filesystem evidence back together", async () => {
  const assessment = await createAssessment({ title: "Reset rollback test" });
  const code = await issueCode(assessment.id);
  const token = (await session(code)).body.sessionToken;
  const started = await start(code, token);
  await checkpoint(checkpointBody(code, token, started.body.startedAt, {
    revision: 3,
    log: [{ type: "voice", text: "must survive reset failure", t: 1 }],
  }));
  const evidence = path.join(dataDir, "submissions", code, "frames", "f_1.jpg");
  mkdirSync(path.dirname(evidence), { recursive: true });
  writeFileSync(evidence, "rollback frame");

  db.exec(`
    CREATE TRIGGER fail_guarded_reset
    BEFORE UPDATE OF status ON codes
    WHEN OLD.code = '${code}' AND NEW.status = 'unused'
    BEGIN SELECT RAISE(ABORT, 'forced reset failure'); END;
  `);
  let failed;
  try {
    failed = await resetCode(code, {
      requestId: `rollback-reset-${code}`,
      expectedGeneration: 0,
      expectedStatus: "active",
    });
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_guarded_reset");
  }
  assert.equal(failed.status, 500, failed.text);
  assert.equal(failed.body.code, "reset_failed");
  assert.equal(db.prepare("SELECT status FROM codes WHERE code = ?").get(code).status, "active");
  assert.equal(db.prepare("SELECT session_generation FROM codes WHERE code = ?").get(code).session_generation, 0);
  assert.equal(db.prepare("SELECT revision FROM session_checkpoints WHERE code = ?").get(code).revision, 3);
  assert.equal(readFileSync(evidence, "utf8"), "rollback frame");
  assert.equal(existsSync(path.join(dataDir, "submissions", code, "_reset")), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM session_resets WHERE code = ?").get(code).n, 0);
  assert.equal((await session(code, token)).body.owned, true);
});

test("OpenAPI documents session ownership, generation reset, checkpoints, and protected uploads", async () => {
  const spec = await request("/api/openapi.json");
  assert.equal(spec.status, 200, spec.text);
  assert.ok(spec.body.components.securitySchemes.assessmentSession);
  assert.ok(spec.body.components.schemas.AssessmentCheckpoint);
  assert.ok(spec.body.paths["/api/assessment/checkpoint"]?.post);
  assert.ok(spec.body.paths["/api/admin/codes/{code}/reset"]?.post);
  assert.match(spec.body.paths["/api/assessment/session"].get.description, /owner/i);
  assert.match(spec.body.paths["/api/assessment/frames"].post.description, /submitted/i);
});
