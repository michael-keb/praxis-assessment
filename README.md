# Praxis Reasoning Assessment

Full-stack React app. One problem, 15 minutes, hard timer, any tools permitted
including AI. Candidates **sign up for an account**, open their **unique
server-issued code link**, and must share their **entire screen** — the
assessment locks and the timer pauses whenever sharing stops (cumulative
pause capped at 5 min, then auto-submit).

## Stack

- **Client** — React 18 + Vite + React Router (`client/`). The session
  engine (`client/src/engine.js`) is framework-agnostic: timer + pause
  accounting, entire-screen enforcement, event logging, localStorage
  resume, 1fps frame shipping.
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
ADMIN_EMAIL=admin@local ADMIN_PASSWORD=adminpass npm run dev:server   # API :8080
npm run dev                                                            # Vite :5173 (proxies /api)
# or production-style: npm run build && npm start
```

## Operating it

1. Log in at `/auth` with the admin account, you land on `/admin`.
2. Issue codes — each row has a copy-ready link: `https://host/assess?case=7K2M9Q`.
3. Send one link per candidate. The candidate signs up (name, email,
   password, Upwork profile URL), consents to recording, and shares their
   entire screen; only then does the timer start.
4. Codes are single-use and bind to the account **and** device that starts
   them; `void` a code to disable it.
5. Review in `/admin`: per-session page shows candidate identity, zones,
   confidence, paused time, full event log, 1fps frame filmstrip; `zip`
   downloads everything for offline processing (manual → Lambda → ReqOps
   Capture flow).

## Session mechanics

- Timer runs **only** while the page is open and the entire screen is
  shared. Tab/window shares are rejected with a retry prompt.
- Sharing stops → full-screen lock, timer paused, pause budget counting
  down. Budget exhausted → auto-submit (`end.reason = "pause_limit"`).
- Closing the tab counts as paused time; reopening the link resumes
  (same browser). 0:00 → auto-submit (`expired`).
- The server attaches the signed-in account identity to the payload —
  the client cannot claim to be someone else.

## Data

`data/` (Docker volume `assessment-data`):

- `assessment.db` — users, codes (status: unused → active → submitted; void)
- `submissions/<CODE>/payload.json` — zones, confidence, `pausedTotal`,
  candidate identity, full event log
- `submissions/<CODE>/frames/f_<t>.jpg` — 1fps frames; `t` is seconds of
  assessment time (pauses excluded), joins the event log directly

Event types: `unlock`, `end` (`submitted`|`expired`|`pause_limit`),
`paste`/`cut` (per-zone chars), `focus`/`blur` (zone), `idle` (≥8s),
`blur_tab`/`return_tab`, `reground`, `confidence`, `resume`,
`capture_declined`, `capture_blocked`/`capture_restored`.

## Config

- `client/src/engine.js` — `DURATION` (15 min), `PAUSE_LIMIT` (5 min).
- Server env — `PORT`, `DATA_DIR`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
  `JWT_SECRET` (optional; auto-generated and persisted if unset).

The previous zero-dependency Python implementation is kept in `legacy/`.
