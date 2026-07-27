import express from "express";
import cookieParser from "cookie-parser";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { seedAdmin, DATA_DIR } from "./db.js";
import { authRouter } from "./auth.js";
import { assessmentRouter } from "./assessment.js";
import { adminRouter } from "./admin.js";
import { integrationsRouter } from "./integrations.js";
import { docsRouter } from "./openapi.js";
import { PORT } from "./config.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, "dist");

seedAdmin();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);          // behind Render's TLS proxy
app.use(express.json({ limit: "8mb" }));
app.use(cookieParser());

/* Platform health check — must not be swallowed by the SPA fallback. */
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRouter);
app.use("/api/assessment", assessmentRouter);
app.use("/api/admin", adminRouter);
app.use("/api/integrations", integrationsRouter);

/* Swagger UI at /api/docs, raw spec at /api/openapi.json. Under /api/ so the
   SPA fallback below leaves it alone. */
app.use("/api", docsRouter);

/* Built React app + SPA fallback. */
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(DIST, "index.html"));
  });
} else {
  app.get("*", (req, res) => res
    .status(503)
    .send("Client not built. Run: npm run build (or use the Vite dev server: npm run dev)"));
}

app.listen(PORT, () => {
  console.log(`Praxis assessment server on http://0.0.0.0:${PORT}`);
  console.log(`  data: ${DATA_DIR}`);
  console.log(`  docs: http://0.0.0.0:${PORT}/api/docs`);
});
