# Praxis Reasoning Assessment

One problem, 15 minutes, hard timer, any tools permitted including AI.
Candidates must share their **entire screen**; the assessment locks and the
timer pauses whenever sharing stops (cumulative pause capped, default 5 min).
Access is by server-issued unique code only.

## Components

| File | Role |
|---|---|
| `assessment.html` | Candidate page (served by the server, never opened directly) |
| `server.py` | Full backend — zero dependencies, Python 3.8+ stdlib only |
| `Dockerfile` / `docker-compose.yml` | Deployment with automatic HTTPS (Caddy) |

## Deploy (Docker, recommended)

```bash
DOMAIN=assess.example.com ADMIN_TOKEN=$(openssl rand -hex 16) docker compose up -d
```

Point DNS for `DOMAIN` at the machine first; Caddy fetches TLS certificates
automatically. **HTTPS is mandatory** — browsers refuse screen sharing on
insecure origins (localhost is the only exception, useful for testing).

## Deploy (bare, no Docker)

```bash
ADMIN_TOKEN=your-secret PORT=8080 python3 server.py
```

Put nginx/Caddy with TLS in front. Data lands in `./data/`
(`assessment.db` + `submissions/<CODE>/payload.json` + `frames/`).

## Operating it

1. Open `https://your-host/admin?token=<ADMIN_TOKEN>`.
2. Issue codes — each row shows a ready-to-copy candidate link:
   `https://your-host/assess?case=7K2M9Q`.
3. Send one link per candidate. Codes are single-use: once submitted
   (or expired) the link shows a completion screen and cannot be rerun.
   A code started on one device cannot be opened on another; `void` a
   code from the dashboard to disable it (issue a new one to re-invite).
4. Review from the dashboard: per-session page shows zones, confidence,
   Upwork profile, total paused time, the full event log, and a 1fps
   frame filmstrip. `zip` downloads the whole session for offline
   processing (your manual → Lambda → ReqOps Capture flow).

## Session mechanics

- Timer runs **only** while the page is open and the entire screen is
  shared. Tab/window shares are rejected with a retry prompt.
- Sharing stops → full-screen lock, timer paused, pause budget shown.
  Budget exhausted → work auto-submits (`end.reason = "pause_limit"`).
- Closing the tab counts as paused time; reopening the link resumes.
- 0:00 → auto-submit (`expired`). Manual submit needs a confidence
  selection and a double-click confirm.

## Config knobs

Top of `assessment.html`: `DURATION` (seconds), `ENDPOINT`, `PAUSE_LIMIT`
(seconds). Server env: `PORT`, `DATA_DIR`, `ADMIN_TOKEN` (auto-generated
and printed if unset — set it explicitly in production).

## Payload

`POST /api/assessment` on submit/expiry:

```json
{
  "caseId": "7K2M9Q",
  "startedAt": 1758000000000,
  "upworkProfile": "https://www.upwork.com/freelancers/~01...",
  "zones": { "1": "...", "2": "...", "3": "...", "4": "..." },
  "confidence": "moderate",
  "pausedTotal": 42000,
  "log": [ { "t": 0, "type": "unlock" }, ... ]
}
```

Event types: `unlock`, `end` (`submitted` | `expired` | `pause_limit`),
`paste`/`cut` (per-zone char counts), `focus`/`blur` (zone), `idle`
(≥8 s gaps), `blur_tab`/`return_tab`, `reground`, `confidence`, `resume`,
`capture_declined`, `capture_blocked`/`capture_restored` (pause windows).
Frames are `submissions/<CODE>/frames/f_<t>.jpg`, `t` = seconds of
assessment time (pauses excluded) — joins the event log directly.
