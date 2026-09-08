import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never use the developer's or production assessment database for browser tests.
const dataDir = mkdtempSync(join(tmpdir(), "praxis-brief-test-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  ASSESSMENT_PORT: "18124",
  DATA_DIR: dataDir,
  ADMIN_EMAIL: "brief-test@example.test",
  ADMIN_PASSWORD: "local-brief-test-only",
  JWT_SECRET: "local-brief-test-only",
  ASSEMBLYAI_API_KEY: "",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit());
process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));
await import("../server/index.js");
