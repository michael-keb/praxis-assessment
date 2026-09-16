/* Integrations issuance is idempotent under a caller-owned clientRef, and the
   lookup route lets a caller that lost the response reconcile instead of
   minting a second code. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const API_KEY = "integrations-test-key";
let server, port, baseUrl, dataDir, output = "";

async function unusedPort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close((e) => e ? reject(e) : resolve(p)); });
  });
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "praxis-integrations-"));
  port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "test", ASSESSMENT_PORT: String(port), DATA_DIR: dataDir,
      ADMIN_EMAIL: "i@example.test", ADMIN_PASSWORD: "local-only", JWT_SECRET: "local-jwt",
      ASSEMBLYAI_API_KEY: "", EXTENSION_API_KEY: API_KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (c) => { output += c; });
  server.stderr.on("data", (c) => { output += c; });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${output}`);
    try { if ((await fetch(`${baseUrl}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`server did not become healthy:\n${output}`);
});

after(async () => {
  if (server && server.exitCode === null) { const exited = new Promise((r) => server.once("exit", r)); server.kill("SIGTERM"); await exited; }
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(pathname, { method = "GET", body, key = API_KEY } = {}) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, text };
}

test("issuance without clientRef mints a fresh code every time", async () => {
  const a = await call("/api/integrations/codes", { method: "POST", body: {} });
  const b = await call("/api/integrations/codes", { method: "POST", body: {} });
  assert.equal(a.status, 200, a.text);
  assert.match(a.body.code, /^[A-Z0-9]{6}$/);
  assert.notEqual(a.body.code, b.body.code);
  assert.equal(a.body.reused, undefined);
});

test("the same clientRef returns the same code instead of minting again", async () => {
  const first = await call("/api/integrations/codes", { method: "POST", body: { clientRef: "rm:email:abc123" } });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.body.reused, false);
  assert.equal(first.body.clientRef, "rm:email:abc123");
  const again = await call("/api/integrations/codes", { method: "POST", body: { clientRef: "rm:email:abc123" } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.body.code, first.body.code);
  assert.equal(again.body.url, first.body.url);
  assert.equal(again.body.reused, true);
  const other = await call("/api/integrations/codes", { method: "POST", body: { clientRef: "rm:email:other" } });
  assert.notEqual(other.body.code, first.body.code);
});

test("concurrent issuance under one clientRef yields one code", async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () =>
    call("/api/integrations/codes", { method: "POST", body: { clientRef: "rm:email:race" } })));
  const codes = new Set(results.map((r) => r.body.code));
  assert.deepEqual(results.map((r) => r.status), Array(6).fill(200));
  assert.equal(codes.size, 1);
  assert.equal(results.filter((r) => r.body.reused === false).length, 1);
});

test("lookup by clientRef reconciles a lost response; 404 when nothing was minted", async () => {
  const missing = await call("/api/integrations/codes?clientRef=rm:email:never");
  assert.equal(missing.status, 404);
  const issued = await call("/api/integrations/codes", { method: "POST", body: { clientRef: "rm:email:lookup" } });
  const found = await call("/api/integrations/codes?clientRef=rm:email:lookup");
  assert.equal(found.status, 200, found.text);
  assert.equal(found.body.code, issued.body.code);
  assert.equal(found.body.url, issued.body.url);
  assert.equal(found.body.status, "unused");
  assert.equal(found.body.clientRef, "rm:email:lookup");
});

test("clientRef is validated and the routes stay behind the API key", async () => {
  const bad = await call("/api/integrations/codes", { method: "POST", body: { clientRef: "has spaces!" } });
  assert.equal(bad.status, 400);
  const noRef = await call("/api/integrations/codes");
  assert.equal(noRef.status, 400);
  const unauth = await call("/api/integrations/codes?clientRef=x", { key: "wrong" });
  assert.equal(unauth.status, 401);
});
