import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

test("OpenAPI documents session ownership, checkpoints, and protected uploads", async () => {
  const spec = await request("/api/openapi.json");
  assert.equal(spec.status, 200, spec.text);
  assert.ok(spec.body.components.securitySchemes.assessmentSession);
  assert.ok(spec.body.components.schemas.AssessmentCheckpoint);
  assert.ok(spec.body.paths["/api/assessment/checkpoint"]?.post);
  assert.match(spec.body.paths["/api/assessment/session"].get.description, /owner/i);
  assert.match(spec.body.paths["/api/assessment/frames"].post.description, /submitted/i);
});
