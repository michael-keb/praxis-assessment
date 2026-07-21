#!/usr/bin/env python3
"""
Praxis Assessment Server — full stack, zero-dependency (Python 3.8+ stdlib).

Candidate:
  GET  /assess?case=XXXXXX          -> assessment page (only for issued codes)
  GET  /api/assessment/session      -> code status for the page
  POST /api/assessment/start        -> mark code active (on unlock)
  POST /api/assessment              -> final payload -> submissions/<code>/payload.json
  POST /api/assessment/frames       -> 1fps frames  -> submissions/<code>/frames/

Admin (token required — ADMIN_TOKEN env, or auto-generated and printed at boot):
  GET  /admin?token=...             -> dashboard: issue codes, session table
  POST /admin/api/codes             -> issue N codes
  POST /admin/api/void              -> void a code
  GET  /case/<code>?token=...       -> review page (zones, log, frame strip)
  GET  /case/<code>/download        -> zip of the session
  GET  /case/<code>/frame/<name>    -> single frame

Storage: DATA_DIR (default ./data)
  data/assessment.db                -> codes + status (sqlite)
  data/submissions/<code>/...       -> payload.json + frames/

Run:   ADMIN_TOKEN=secret PORT=8080 python3 server.py
HTTPS: required for candidates (getDisplayMedia refuses insecure origins);
       see docker-compose.yml for a Caddy setup with automatic certificates.
"""

import io
import json
import os
import re
import secrets
import sqlite3
import sys
import zipfile
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default as email_default_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(BASE_DIR, "data"))
SUBMISSIONS_DIR = os.path.join(DATA_DIR, "submissions")
DB_PATH = os.path.join(DATA_DIR, "assessment.db")
HTML_PATH = os.path.join(BASE_DIR, "assessment.html")
PORT = int(os.environ.get("PORT", "8080"))
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
MAX_BODY = 64 * 1024 * 1024

CODE_RE = re.compile(r"^[A-Z0-9]{6}$")
FRAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}\.(jpg|jpeg|png)$")
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # no 0/O/1/I/L


# ---------------------------------------------------------------- database

def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    os.makedirs(SUBMISSIONS_DIR, exist_ok=True)
    with db() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS codes (
            code TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'unused',   -- unused|active|submitted|void
            started_at TEXT,
            submitted_at TEXT,
            end_reason TEXT)""")


def get_code(code):
    with db() as conn:
        row = conn.execute("SELECT * FROM codes WHERE code = ?", (code,)).fetchone()
    return dict(row) if row else None


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_codes(count):
    issued = []
    with db() as conn:
        while len(issued) < count:
            code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
            try:
                conn.execute("INSERT INTO codes (code, created_at) VALUES (?, ?)",
                             (code, now_iso()))
                issued.append(code)
            except sqlite3.IntegrityError:
                continue
    return issued


def safe_code(raw):
    raw = (raw or "").strip().upper()
    return raw if CODE_RE.match(raw) else None


def esc(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;"))


# ---------------------------------------------------------------- handler

class Handler(BaseHTTPRequestHandler):
    server_version = "PraxisAssessment/2.0"

    def _send(self, code, body, ctype="text/html; charset=utf-8", extra=None):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for key, val in (extra or {}).items():
            self.send_header(key, val)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj), "application/json")

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return None
        return self.rfile.read(length)

    def _json_body(self):
        raw = self._body()
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return None

    def _is_admin(self, query):
        supplied = query.get("token", [""])[0] or self.headers.get("X-Admin-Token", "")
        return bool(ADMIN_TOKEN) and secrets.compare_digest(supplied, ADMIN_TOKEN)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (now_iso(), fmt % args))

    # ------------------------------------------------------------ routing

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]

        if url.path in ("/", "/assess"):
            return self._serve_assessment(query)
        if url.path == "/api/assessment/session":
            return self._api_session(query)
        if url.path == "/admin":
            if not self._is_admin(query):
                return self._send(403, "Forbidden — append ?token=<ADMIN_TOKEN>")
            return self._page_admin(query)
        if len(parts) >= 2 and parts[0] == "case":
            code = safe_code(parts[1])
            if not code or not get_code(code):
                return self._send(404, "Unknown case")
            if not self._is_admin(query):
                return self._send(403, "Forbidden")
            if len(parts) == 2:
                return self._page_case(code, query)
            if len(parts) == 3 and parts[2] == "download":
                return self._zip_case(code)
            if len(parts) == 4 and parts[2] == "frame" and FRAME_RE.match(parts[3]):
                return self._serve_frame(code, parts[3])
        return self._send(404, "Not found")

    def do_POST(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path == "/api/assessment/start":
            return self._api_start()
        if url.path == "/api/assessment":
            return self._api_payload()
        if url.path == "/api/assessment/frames":
            return self._api_frames()
        if url.path == "/admin/api/codes":
            if not self._is_admin(query):
                return self._json(403, {"error": "forbidden"})
            return self._api_new_codes()
        if url.path == "/admin/api/void":
            if not self._is_admin(query):
                return self._json(403, {"error": "forbidden"})
            return self._api_void()
        return self._send(404, "Not found")

    # ------------------------------------------------------------ candidate

    def _serve_assessment(self, query):
        code = safe_code(query.get("case", [""])[0])
        if not code or not get_code(code):
            return self._send(403, INVALID_LINK_HTML)
        try:
            with open(HTML_PATH, "rb") as fh:
                return self._send(200, fh.read())
        except OSError:
            return self._send(500, "assessment.html missing on server")

    def _api_session(self, query):
        code = safe_code(query.get("case", [""])[0])
        row = get_code(code) if code else None
        if not row:
            return self._json(200, {"status": "unknown"})
        return self._json(200, {"status": row["status"],
                                "startedAt": row["started_at"],
                                "endReason": row["end_reason"]})

    def _api_start(self):
        body = self._json_body() or {}
        code = safe_code(body.get("caseId"))
        row = get_code(code) if code else None
        if not row:
            return self._json(403, {"error": "unknown code"})
        if row["status"] == "void":
            return self._json(403, {"error": "code voided"})
        if row["status"] == "submitted":
            return self._json(403, {"error": "already submitted"})
        if row["status"] == "unused":
            with db() as conn:
                conn.execute("UPDATE codes SET status='active', started_at=? WHERE code=? AND status='unused'",
                             (now_iso(), code))
            self.log_message("session started: %s", code)
        return self._json(200, {"ok": True})

    def _api_payload(self):
        payload = self._json_body()
        if payload is None:
            return self._json(400, {"error": "invalid json"})
        code = safe_code(payload.get("caseId"))
        row = get_code(code) if code else None
        if not row or row["status"] == "void":
            return self._json(403, {"error": "unknown or voided code"})
        if row["status"] == "submitted":
            return self._json(409, {"error": "already submitted"})
        payload["_receivedAt"] = now_iso()
        end = next((e for e in reversed(payload.get("log", [])) if e.get("type") == "end"), {})
        target_dir = os.path.join(SUBMISSIONS_DIR, code)
        os.makedirs(target_dir, exist_ok=True)
        with open(os.path.join(target_dir, "payload.json"), "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, ensure_ascii=False)
        with db() as conn:
            conn.execute("UPDATE codes SET status='submitted', submitted_at=?, end_reason=? WHERE code=?",
                         (now_iso(), end.get("reason", "?"), code))
        self.log_message("payload stored: %s (%s, %d events)",
                         code, end.get("reason", "?"), len(payload.get("log", [])))
        return self._json(200, {"ok": True})

    def _api_frames(self):
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            return self._json(400, {"error": "expected multipart/form-data"})
        raw = self._body()
        if raw is None:
            return self._json(400, {"error": "empty or oversized body"})
        msg = BytesParser(policy=email_default_policy).parsebytes(
            b"Content-Type: " + ctype.encode("latin-1") + b"\r\nMIME-Version: 1.0\r\n\r\n" + raw)
        code, frames = None, []
        for part in msg.iter_parts():
            name = part.get_param("name", header="content-disposition")
            filename = part.get_filename()
            if name == "caseId" and not filename:
                code = safe_code(part.get_payload(decode=True).decode("utf-8", "replace"))
            elif name == "frames" and filename:
                frames.append((os.path.basename(filename), part.get_payload(decode=True)))
        row = get_code(code) if code else None
        if not row or row["status"] in ("void", "unused"):
            return self._json(403, {"error": "unknown or inactive code"})
        frames_dir = os.path.join(SUBMISSIONS_DIR, code, "frames")
        os.makedirs(frames_dir, exist_ok=True)
        saved = 0
        for filename, blob in frames:
            if blob and FRAME_RE.match(filename):
                with open(os.path.join(frames_dir, filename), "wb") as fh:
                    fh.write(blob)
                saved += 1
        return self._json(200, {"ok": True, "saved": saved})

    # ------------------------------------------------------------ admin

    def _api_new_codes(self):
        body = self._json_body() or {}
        count = body.get("count", 1)
        if not isinstance(count, int) or not 1 <= count <= 200:
            return self._json(400, {"error": "count must be 1-200"})
        codes = new_codes(count)
        self.log_message("issued %d codes", count)
        return self._json(200, {"codes": codes})

    def _api_void(self):
        body = self._json_body() or {}
        code = safe_code(body.get("code"))
        if not code or not get_code(code):
            return self._json(404, {"error": "unknown code"})
        with db() as conn:
            conn.execute("UPDATE codes SET status='void' WHERE code=?", (code,))
        self.log_message("voided: %s", code)
        return self._json(200, {"ok": True})

    def _link_base(self):
        proto = self.headers.get("X-Forwarded-Proto", "http")
        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host", "localhost")
        return "%s://%s" % (proto, host)

    def _page_admin(self, query):
        token = query.get("token", [""])[0]
        base = self._link_base()
        with db() as conn:
            rows = conn.execute("SELECT * FROM codes ORDER BY created_at DESC").fetchall()
        counts = {}
        for row in rows:
            counts[row["status"]] = counts.get(row["status"], 0) + 1
        table = []
        for row in rows:
            code = row["code"]
            frames_dir = os.path.join(SUBMISSIONS_DIR, code, "frames")
            n_frames = len(os.listdir(frames_dir)) if os.path.isdir(frames_dir) else 0
            link = "%s/assess?case=%s" % (base, code)
            actions = []
            if row["status"] == "submitted" or n_frames:
                actions.append("<a href='/case/%s?token=%s'>review</a>" % (code, token))
                actions.append("<a href='/case/%s/download?token=%s'>zip</a>" % (code, token))
            if row["status"] not in ("void", "submitted"):
                actions.append(
                    "<a href='#' onclick=\"voidCode('%s');return false\">void</a>" % code)
            table.append(
                "<tr><td><code>%s</code></td><td><input readonly value='%s' size=42 "
                "onclick='this.select()'></td><td>%s</td><td>%s</td><td>%s</td>"
                "<td>%d</td><td>%s</td></tr>" % (
                    code, esc(link), row["status"], esc(row["started_at"] or ""),
                    esc(row["submitted_at"] or ""), n_frames, " &middot; ".join(actions)))
        body = ADMIN_HTML % {
            "summary": " &middot; ".join("%s: %d" % kv for kv in sorted(counts.items())) or "no codes yet",
            "rows": "".join(table) or "<tr><td colspan=7>none yet</td></tr>",
            "token": esc(token),
        }
        return self._send(200, body)

    def _load_payload(self, code):
        try:
            with open(os.path.join(SUBMISSIONS_DIR, code, "payload.json"), encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None

    def _page_case(self, code, query):
        token = query.get("token", [""])[0]
        payload = self._load_payload(code)
        out = ["<meta charset='utf-8'><body style='font-family:sans-serif;max-width:960px;margin:2em auto'>"]
        out.append("<p><a href='/admin?token=%s'>&larr; admin</a> &middot; "
                   "<a href='/case/%s/download?token=%s'>download zip</a></p>" % (token, code, token))
        out.append("<h1>Case %s</h1>" % code)
        if payload:
            paused = payload.get("pausedTotal")
            out.append("<p><b>Upwork:</b> %s<br><b>Confidence:</b> %s<br><b>Received:</b> %s"
                       "<br><b>Paused total:</b> %ss</p>" % (
                           esc(payload.get("upworkProfile", "")), esc(payload.get("confidence")),
                           esc(payload.get("_receivedAt", "")),
                           esc(round(paused / 1000) if isinstance(paused, (int, float)) else "?")))
            for zone in ("1", "2", "3", "4"):
                out.append("<h3>Zone %s</h3><pre style='white-space:pre-wrap;background:#f6f6f6;"
                           "padding:1em'>%s</pre>" % (zone, esc(payload.get("zones", {}).get(zone) or "(empty)")))
            out.append("<h3>Event log</h3><table border=1 cellpadding=4 cellspacing=0>"
                       "<tr><th>t</th><th>type</th><th>detail</th></tr>")
            for ev in payload.get("log", []):
                detail = {k: v for k, v in ev.items() if k not in ("t", "type")}
                out.append("<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (
                    esc(ev.get("t")), esc(ev.get("type")), esc(detail or "")))
            out.append("</table>")
        else:
            out.append("<p><i>No payload yet (in progress, or lost before submit).</i></p>")
        frames_dir = os.path.join(SUBMISSIONS_DIR, code, "frames")
        names = sorted(os.listdir(frames_dir)) if os.path.isdir(frames_dir) else []

        def frame_t(name):
            match = re.search(r"f_(\d+)\.", name)
            return int(match.group(1)) if match else 0
        names.sort(key=frame_t)
        out.append("<h3>Frames (%d)</h3>" % len(names))
        for name in names:
            out.append("<figure style='display:inline-block;margin:4px;text-align:center'>"
                       "<a href='/case/%s/frame/%s?token=%s'><img src='/case/%s/frame/%s?token=%s' "
                       "width=220 loading=lazy></a><figcaption style='font-size:11px'>t=%ds"
                       "</figcaption></figure>" % (code, name, token, code, name, token, frame_t(name)))
        return self._send(200, "".join(out))

    def _serve_frame(self, code, name):
        try:
            with open(os.path.join(SUBMISSIONS_DIR, code, "frames", name), "rb") as fh:
                return self._send(200, fh.read(), "image/jpeg")
        except OSError:
            return self._send(404, "No such frame")

    def _zip_case(self, code):
        buf = io.BytesIO()
        root = os.path.join(SUBMISSIONS_DIR, code)
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            if os.path.isdir(root):
                for dirpath, _dirs, files in os.walk(root):
                    for name in files:
                        full = os.path.join(dirpath, name)
                        zf.write(full, os.path.join(code, os.path.relpath(full, root)))
            row = get_code(code)
            if row:
                zf.writestr(os.path.join(code, "code-record.json"), json.dumps(row, indent=2))
        return self._send(200, buf.getvalue(), "application/zip",
                          {"Content-Disposition": "attachment; filename=%s.zip" % code})


INVALID_LINK_HTML = """<!doctype html><meta charset='utf-8'>
<body style='font-family:sans-serif;max-width:520px;margin:18vh auto;text-align:center'>
<h1 style='letter-spacing:.14em'>PRAXIS</h1>
<h2>This assessment link is not valid</h2>
<p>The link is missing its access code or the code was not recognised.
Please use the exact link you were sent, or contact the person who invited you.</p>"""

ADMIN_HTML = """<!doctype html><meta charset='utf-8'>
<title>Praxis Assessment — admin</title>
<body style='font-family:sans-serif;max-width:1100px;margin:2em auto'>
<h1>Praxis Assessment — admin</h1>
<p>%(summary)s</p>
<form onsubmit='issue();return false' style='margin:1em 0'>
  <input type=number id=count value=5 min=1 max=200 style='width:5em'>
  <button>Issue codes</button>
</form>
<table border=1 cellpadding=6 cellspacing=0>
<tr><th>Code</th><th>Candidate link</th><th>Status</th><th>Started</th>
<th>Submitted</th><th>Frames</th><th>Actions</th></tr>
%(rows)s
</table>
<script>
var TOKEN = %(token)r;
function issue() {
  fetch('/admin/api/codes?token=' + TOKEN, {method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({count: parseInt(document.getElementById('count').value, 10) || 1})})
    .then(function(r){return r.json();})
    .then(function(){location.reload();});
}
function voidCode(code) {
  if (!confirm('Void code ' + code + '? The link stops working permanently.')) return;
  fetch('/admin/api/void?token=' + TOKEN, {method:'POST',
    headers:{'Content-Type':'application/json'}, body: JSON.stringify({code: code})})
    .then(function(){location.reload();});
}
</script>"""


def main():
    global ADMIN_TOKEN
    init_db()
    if not ADMIN_TOKEN:
        ADMIN_TOKEN = secrets.token_urlsafe(18)
        print("ADMIN_TOKEN not set — generated for this run:\n  %s" % ADMIN_TOKEN)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("Praxis assessment server on http://0.0.0.0:%d" % PORT)
    print("  admin:  /admin?token=%s" % ADMIN_TOKEN)
    print("  data:   %s" % DATA_DIR)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
