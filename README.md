# Praxis Reasoning Assessment

Full-stack React app. One problem, 15 minutes, hard timer, any tools permitted
including AI. Candidates open their **unique server-issued code link**, provide
the requested profile details, and must share their **entire screen** — the
assessment locks and the timer pauses whenever sharing stops (cumulative
pause capped at 5 min, then auto-submit).

## Stack

- **Client** — React 18 + Vite + React Router (`client/`). The session
  engine (`client/src/engine.js`) is framework-agnostic: timer + pause
  accounting, entire-screen enforcement, live transcription, durable session
  checkpoints, localStorage resume, and IndexedDB-backed 1fps frame uploads.
- **Server** — Node 22 + Express (`server/`): bcrypt accounts, JWT
  httpOnly-cookie sessions, SQLite (better-sqlite3) for users + codes,
  filesystem for payloads/frames, zip export.
- **Deploy** — Docker multi-stage build + Caddy for automatic HTTPS.

## Deploy

```bash
DOMAIN=assess.example.com \
ADMIN_EMAIL=you@praxis.com ADMIN_PASSWORD=$(openssl rand -hex 12) \
docker compose up -d --build
```

Point DNS for `DOMAIN` at the machine first. **HTTPS is mandatory** —
browsers refuse screen sharing on insecure origins (localhost excepted).

Local development:

```bash
npm install
ADMIN_EMAIL=admin@local ADMIN_PASSWORD=adminpass npm run dev:server   # API :8124
npm run dev                                                            # Vite :5173 (proxies /api)
# or production-style: npm run build && npm start
```

## Operating it

Assessment briefs support formatted paste from documents and web pages, or
Markdown (including text copied from ChatGPT). The admin editor provides heading
levels, bold, italics, bullet and numbered lists, undo/redo, and a candidate
preview. Formatting is saved as Markdown in the existing `brief` field; existing
plain text briefs still preserve paragraphs and line breaks. Candidates see the
same document formatting after starting their assessment.

Run `npm test` for the engine and server session checks. Install Chromium once
with `npx playwright install chromium`, then run `npm run test:briefs` for the
brief editor or `npm run test:experience` for candidate journeys, interrupted
connections, recording recovery, ownership, and submission. Browser suites build
the app and use disposable databases and synthetic media, never live assessments.

1. Log in at `/auth` with the admin account, you land on `/admin`.
2. Issue codes — each row has a copy-ready link: `https://host/assess?case=7K2M9Q`.
3. Send one link per candidate. The candidate provides the assessment's required
   identity, profile or file fields, consents, shares their entire screen, and
   passes a spoken microphone check. The timer starts when the server confirms
   the start and the brief appears.
4. Codes are single-use and bind atomically to a server-issued token held by the
   browser that starts them. The same browser can resume; competing owners are
   rejected. `void` a code to disable it.
5. Review in `/admin`: per-session page shows candidate identity, paused time,
   saved draft or final transcript, event log, and 1fps frame filmstrip; `zip`
   downloads everything for offline processing (manual → Lambda → ReqOps
   Capture flow).

## Session mechanics

- Timer runs **only** while the page is open and the entire screen is
  shared. Tab/window shares are rejected with a retry prompt.
- Sharing stops → full-screen lock, timer paused, pause budget counting
  down. Budget exhausted → auto-submit (`end.reason = "pause_limit"`).
- Closing the tab counts as paused time; reopening the link resumes
  in the same browser with a fresh screen/microphone check. Durable server
  checkpoints retain the transcript and finalize abandoned sessions after the
  remaining pause budget even if the browser never reopens. 0:00 → auto-submit
  (`expired`).
- A disconnected transcription service is retried; exhausted recovery pauses
  the assessment and provides a reconnect action.
- Submission stops capture immediately, then remains on **Saving your session**
  until queued frames and the final result are acknowledged. Failed uploads
  stay in IndexedDB and retry on reconnect or reload.
- The server freezes the assigned brief, duration and required fields at start,
  and attaches the candidate identity captured by that start to the result.
- Existing active sessions created before browser ownership was introduced
  cannot be securely adopted by a new browser. Before deploying this change,
  allow those sessions to finish; otherwise review their evidence, void their
  codes and issue replacement codes. Existing submitted results remain available
  to admins. Preserve the database and JWT secret across restarts.

## Data

`data/` (Docker volume `assessment-data`):

- `assessment.db` — users, codes (status: unused → active → submitted; void),
  frozen assessments, session owners and durable checkpoints
- `submissions/<CODE>/payload.json` — zones, confidence, `pausedTotal`,
  candidate identity, full event log
- `submissions/<CODE>/frames/f_<t>.jpg` — 1fps frames; `t` is seconds of
  assessment time (pauses excluded), joins the event log directly

Event types: `unlock`, `end` (`submitted`|`expired`|`pause_limit`),
`paste`/`cut` (per-zone chars), `focus`/`blur` (zone), `idle` (≥8s),
`blur_tab`/`return_tab`, `reground`, `confidence`, `resume`,
`capture_declined`, `capture_blocked`/`capture_restored`.

## Config

- `client/src/engine.js` — `DEFAULT_DURATION` (15 min), `PAUSE_LIMIT` (5 min).
- `server/config.js` — the listen port, **locked to 8124**.
- Server env — `ASSESSMENT_PORT`, `DATA_DIR`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
  `JWT_SECRET` (optional; auto-generated and persisted if unset),
  `ASSEMBLYAI_API_KEY` (optional; enables the primary live transcription service;
  browser speech recognition is the fallback),
  `EXTENSION_API_KEY` (optional; enables `/api/integrations/*`, see below).

### Port

8124, assigned to this app by the universal port registry
(`Clients/Ports/PORTS.md`) and registered in the Ports Manager on :1983. It was
previously 8080 — the ReqOps frontend's reserved port, so the two knocked each
other offline.

Bare `PORT` is deliberately **not** read: the Claude preview/AI harness injects
it. Override with `ASSESSMENT_PORT` if you must, and keep `Dockerfile`,
`docker-compose.yml`, `render.yaml`, `vite.config.js` and the registry row in
step.

## API docs (Swagger)

The whole HTTP surface is published as OpenAPI 3 from `server/openapi.js`:

- **`/api/docs`** — Swagger UI, "Try it out" enabled against the running server.
- **`/api/openapi.json`** — the raw spec, for codegen or import into Postman.

Both are unauthenticated (the spec documents auth; it doesn't grant it). The
three auth schemes are modelled separately, so the *Authorize* button gives you
the admin session cookie (via `POST /api/auth/login`) and the integrations
Bearer key independently. Add or change a route → update the spec in the same
commit; it is hand-written, not generated from the routers.

## External integrations

`server/integrations.js`, mounted at `/api/integrations/*`, is a
machine-to-machine surface separate from the cookie-auth admin UI — for
external tools that need to issue/check codes without a browser session
(currently: the Upwork candidate-management Chrome extension). Auth is a
single shared secret, not a user session: send
`Authorization: Bearer <EXTENSION_API_KEY>`. If the env var is unset, every
request 401s — the surface is off by default.

- `GET /api/integrations/ping` — auth check, `{ ok: true }`.
- `POST /api/integrations/codes` — body `{ assessmentId? }` (omit for no
  specific assessment), issues one code via the same `newCodes()` used by
  the admin UI. Returns `{ code, url }` where `url` is the candidate-facing
  gate link (`/assess?case=<code>`). Candidate name/email/Upwork profile are
  **not** collected here — the gate captures those itself when the
  candidate opens the link (see `assessment.js` `/start`).
- `GET /api/integrations/codes/:code` — status only:
  `{ code, status, candidateName, startedAt, submittedAt }`. `status` is
  `unused | active | submitted | void`, matching the `codes` table.

Rotate the key by changing `EXTENSION_API_KEY` on Render and in the
extension's Options page together (see `render.yaml`).

The previous zero-dependency Python implementation is kept in `legacy/`.
