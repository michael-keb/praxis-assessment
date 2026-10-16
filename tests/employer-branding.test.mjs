import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
let dataDir;
let baseUrl;
let server;
let serverOutput = "";
let adminCookie;

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

async function request(pathname, { method = "GET", body, headers = {}, admin = false } = {}) {
  const options = { method, headers: { ...headers }, signal: AbortSignal.timeout(5_000) };
  if (admin) options.headers.Cookie = adminCookie;
  if (body instanceof FormData) options.body = body;
  else if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const buffer = Buffer.from(await response.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buffer.toString("utf8")); } catch { /* binary */ }
  return { status: response.status, body: json, buffer, text: buffer.toString("utf8"), headers: response.headers };
}

function fileForm(name, bytes, type) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  return form;
}

async function assessmentBody(extra = {}) {
  return { title: "Branded task", brief: "Secret brief.", durationMinutes: 15, requireLinkedin: false, ...extra };
}

async function session(code, token) {
  return request(`/api/assessment/session?case=${code}`, { headers: token ? { "X-Assessment-Session": token } : {} });
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "praxis-employer-branding-"));
  const port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ASSESSMENT_PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_EMAIL: "branding@example.test",
      ADMIN_PASSWORD: "branding-local-only",
      JWT_SECRET: "branding-local-jwt-only",
      ASSEMBLYAI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${serverOutput}`);
    try { if ((await fetch(`${baseUrl}/healthz`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`server did not become healthy:\n${serverOutput}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const login = await request("/api/auth/login", {
    method: "POST",
    body: { email: "branding@example.test", password: "branding-local-only" },
  });
  assert.equal(login.status, 200, login.text);
  adminCookie = login.headers.get("set-cookie").split(";", 1)[0];
});

after(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test("employers validate input, accept raster logos only, and refuse deletion while in use", async () => {
  assert.equal((await request("/api/admin/employers", { method: "POST", body: { name: "" }, admin: true })).status, 400);
  assert.equal((await request("/api/admin/employers", { method: "POST", body: { name: "X", brandColor: "blue" }, admin: true })).status, 400);
  assert.equal((await request("/api/admin/employers", { method: "POST", body: { name: "X" } })).status, 403);

  const created = await request("/api/admin/employers", { method: "POST", body: { name: "Acme Co", brandColor: "#1A73E8" }, admin: true });
  assert.equal(created.status, 200, created.text);
  const employer = created.body.employer;
  assert.equal(employer.brand_color, "#1a73e8");

  const svg = await request(`/api/admin/employers/${employer.id}/logo`, {
    method: "POST", admin: true, body: fileForm("logo.svg", "<svg/>", "image/svg+xml"),
  });
  assert.equal(svg.status, 400);

  const logo = await request(`/api/admin/employers/${employer.id}/logo`, {
    method: "POST", admin: true, body: fileForm("logo.png", PNG, "image/png"),
  });
  assert.equal(logo.status, 200, logo.text);
  assert.match(logo.body.employer.logo_file, /^\d+-\d+-[0-9a-f]{8}\.png$/);
  const served = await request(`/api/assessment/brand/logos/${logo.body.employer.logo_file}`);
  assert.equal(served.status, 200);
  assert.deepEqual(served.buffer, PNG);
  assert.equal((await request("/api/assessment/brand/logos/..%2Fassessment.db")).status, 404);

  const assessment = await request("/api/admin/assessments", {
    method: "POST", admin: true, body: await assessmentBody({ employerId: employer.id }),
  });
  assert.equal(assessment.status, 200, assessment.text);
  assert.equal((await request(`/api/admin/employers/${employer.id}`, { method: "DELETE", admin: true })).status, 409);
  assert.equal((await request("/api/admin/assessments", {
    method: "POST", admin: true, body: await assessmentBody({ employerId: 99999 }),
  })).status, 400);

  const listed = await request("/api/admin/assessments", { admin: true });
  assert.equal(listed.body.assessments.find((a) => a.id === assessment.body.assessment.id).employer_name, "Acme Co");
});

test("candidates see branding and the job description before start, frozen after start", async () => {
  const employer = (await request("/api/admin/employers", {
    method: "POST", admin: true, body: { name: "Globex", brandColor: "#aa0000" },
  })).body.employer;
  assert.equal((await request("/api/admin/assessments", {
    method: "POST", admin: true, body: await assessmentBody({ jobDescriptionUrl: "javascript:alert(1)" }),
  })).status, 400);
  const created = await request("/api/admin/assessments", {
    method: "POST", admin: true,
    body: await assessmentBody({ employerId: employer.id, jobDescriptionUrl: "globex.example/careers/engineer" }),
  });
  assert.equal(created.status, 200, created.text);
  const assessment = created.body.assessment;
  assert.equal(assessment.job_description_url, "https://globex.example/careers/engineer");

  assert.equal((await request(`/api/admin/assessments/${assessment.id}/job-description`, {
    method: "POST", admin: true, body: fileForm("evil.html", "<script>", "text/html"),
  })).status, 400);
  const jd = await request(`/api/admin/assessments/${assessment.id}/job-description`, {
    method: "POST", admin: true, body: fileForm("Engineer JD.pdf", "%PDF-1.4 first", "application/pdf"),
  });
  assert.equal(jd.status, 200, jd.text);
  assert.equal(jd.body.assessment.job_description_name, "Engineer JD.pdf");

  const code = (await request("/api/admin/codes", { method: "POST", admin: true, body: { count: 1, assessmentId: assessment.id } })).body.codes[0];
  const before = await session(code);
  assert.equal(before.body.assessment.brief, undefined);
  assert.deepEqual(before.body.assessment.employer, { name: "Globex", brandColor: "#aa0000", logo: null });
  assert.deepEqual(before.body.assessment.jobDescription, { url: "https://globex.example/careers/engineer", fileName: "Engineer JD.pdf" });
  const download = await request(`/api/assessment/job-description?case=${code}`);
  assert.equal(download.status, 200);
  assert.equal(download.text, "%PDF-1.4 first");
  assert.match(download.headers.get("content-disposition"), /^inline; filename\*=UTF-8''Engineer%20JD\.pdf$/);

  const started = await request("/api/assessment/start", {
    method: "POST",
    headers: { "X-Assessment-Session": before.body.sessionToken },
    body: { caseId: code, sessionToken: before.body.sessionToken, name: "Brand Candidate" },
  });
  assert.equal(started.status, 200, started.text);

  /* Changing the employer and replacing the file afterwards leaves the started code alone. */
  await request(`/api/admin/employers/${employer.id}`, { method: "PUT", admin: true, body: { name: "Globex Renamed" } });
  await request(`/api/admin/assessments/${assessment.id}/job-description`, {
    method: "POST", admin: true, body: fileForm("New.pdf", "%PDF-1.4 second", "application/pdf"),
  });
  const owned = await session(code, before.body.sessionToken);
  assert.equal(owned.body.assessment.employer.name, "Globex");
  assert.equal((await request(`/api/assessment/job-description?case=${code}`)).text, "%PDF-1.4 first");

  const fresh = (await request("/api/admin/codes", { method: "POST", admin: true, body: { count: 1, assessmentId: assessment.id } })).body.codes[0];
  assert.equal((await session(fresh)).body.assessment.employer.name, "Globex Renamed");
  assert.equal((await request(`/api/assessment/job-description?case=${fresh}`)).text, "%PDF-1.4 second");

  await request(`/api/admin/codes/${fresh}/void`, { method: "POST", admin: true });
  assert.equal((await request(`/api/assessment/job-description?case=${fresh}`)).status, 404);
});

test("assessments without an employer keep ReqOps branding and no job description", async () => {
  const code = (await request("/api/admin/codes", { method: "POST", admin: true, body: { count: 1 } })).body.codes[0];
  const info = await session(code);
  assert.equal(info.body.assessment.employer, null);
  assert.equal(info.body.assessment.jobDescription, null);
  assert.equal((await request(`/api/assessment/job-description?case=${code}`)).status, 404);
});
