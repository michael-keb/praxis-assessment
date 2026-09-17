import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
let server, port, baseUrl, dataDir, output = "";

async function unusedPort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close((e) => e ? reject(e) : resolve(p));
    });
  });
}

before(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "praxis-nfiny-progress-"));
  port = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      ASSESSMENT_PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_EMAIL: "nfiny@example.test",
      ADMIN_PASSWORD: "local-only",
      JWT_SECRET: "local-jwt",
      ASSEMBLYAI_API_KEY: "",
      EXTENSION_API_KEY: "nfiny-test-key",
    },
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
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test("serves the Nfiny backend engineer progress report", async () => {
  const response = await fetch(`${baseUrl}/nfiny/backend-engineer`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  const html = await response.text();
  assert.match(html, /Backend Engineering · Progress Update/);
  assert.match(html, /Moving to round two/);
});

test("trailing slash reaches the same report", async () => {
  const response = await fetch(`${baseUrl}/nfiny/backend-engineer/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Backend Engineering · Progress Update/);
});
