/* Host port, assigned by the universal port registry
   (/Users/mk/Documents/Clients/Ports/PORTS.md) and locked to this app: 8124.

   In development, deliberately NOT bare `process.env.PORT` — the Claude
   preview/AI harness injects PORT and hijacks it, and the old default (8080)
   belonged to the ReqOps frontend. ASSESSMENT_PORT is the only override.
   Change it here and in Dockerfile / docker-compose.yml / render.yaml /
   vite.config.js together, and update the registry row.

   In production the host picks the port instead: Render injects PORT (10000)
   and health-checks that exact port, so ignoring it binds 8124 and fails
   every deploy. Honour PORT there — ASSESSMENT_PORT still wins if set. */
const hostPort = process.env.NODE_ENV === "production" ? Number(process.env.PORT) : 0;
export const PORT = Number(process.env.ASSESSMENT_PORT) || hostPort || 8124;

/* AssemblyAI Universal-Streaming — live transcription during sessions. The
   key stays server-side; the browser only ever receives short-lived tokens
   (see /api/assessment/transcribe-token). Absent key = the client falls back
   to the browser's own speech recognition. */
export const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY || "";
