import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";
import { createEngine } from "../engine.js";

const fmt = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

const DEFAULT_TITLE = "Assessment";
const DEFAULT_BRIEF =
  "Create something from nothing. Use this time however you need — " +
  "build, research, draft, prototype. Speak out loud as you go so we can follow how you think.";

function Brief({ text, className }) {
  const paras = (text || DEFAULT_BRIEF).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paras.map((p, i) => (
    <p className={className} key={i}>
      {p.split("\n").flatMap((line, j) => (j === 0 ? [line] : [<br key={j} />, line]))}
    </p>
  ));
}

export default function AssessmentPage() {
  const [params] = useSearchParams();
  const caseId = (params.get("case") || "").trim().toUpperCase();
  const engine = useMemo(() => createEngine(caseId), [caseId]);
  const snap = useSyncExternalStore(engine.subscribe, engine.snapshot, engine.snapshot);

  useEffect(() => {
    engine.boot();
    return () => engine.destroy();
  }, [engine]);

  if (snap.phase === "loading") return null;
  if (snap.phase === "fatal") return <CenterScreen mark="⚠" title={snap.fatal.title} text={snap.fatal.text} />;
  if (snap.phase === "done") return <DoneScreen reason={snap.doneReason} />;
  if (snap.phase === "gate") return <Gate engine={engine} snap={snap} />;
  return <Task engine={engine} snap={snap} />;
}

function CenterScreen({ mark, title, text }) {
  return (
    <div className="center-screen">
      <div className="mark">{mark}</div>
      <h1>{title}</h1>
      <p style={{ maxWidth: 480, margin: "0 auto" }}>{text}</p>
    </div>
  );
}

function DoneScreen({ reason }) {
  const copy = {
    expired: ["⏱", "Time expired",
      "The timer reached zero. Your screen and voice recording were submitted. You may close this tab."],
    pause_limit: ["⏱", "Pause limit reached",
      "Screen sharing was paused for longer than the allowed limit, so your session was submitted as-is. You may close this tab."]
  }[reason] || ["✓", "Session submitted",
    "Thank you. Your screen and voice recording have been recorded. You may close this tab."];
  return <CenterScreen mark={copy[0]} title={copy[1]} text={copy[2]} />;
}

function Gate({ engine, snap }) {
  const [step, setStep] = useState("details");   // details | confirm
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", upwork: "" });
  const [cvFile, setCvFile] = useState(null);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const cvOk = cvFile && /\.(pdf|doc|docx)$/i.test(cvFile.name) && cvFile.size <= 8 * 1024 * 1024;
  const detailsComplete =
    form.name.trim() &&
    /^https?:\/\/(www\.)?upwork\.com\/.+/i.test(form.upwork.trim()) &&
    cvOk;

  async function begin() {
    setBusy(true);
    setError("");
    const result = await engine.begin({
      name: form.name.trim(),
      upwork: form.upwork.trim(),
      cvFile
    });
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
    }
  }

  if (step === "confirm") {
    return (
      <div className="screen">
        <div className="card-col">
          <div className="gate-mark">praxis</div>
          <h1>Before you start</h1>
          <p className="lede">
            The assessment brief is revealed the moment your screen and microphone
            are connected — and the clock starts with it.
          </p>
          <div className="gate-warning">
            <ul>
              <li><b>The timer starts immediately.</b> You will have {fmt(snap.duration)},
                with a hard stop at 0:00 — your session submits automatically, finished or not.</li>
              <li><b>This code is single-use.</b> Once started there is no restart and no
                fresh timer. Only begin when you are ready to spend the full time now.</li>
              <li><b>Your entire screen and microphone are recorded</b> for the whole
                session. Think out loud the entire time.</li>
              <li><b>Stopping the share pauses and locks the page</b> — not the assessment.
                Total pause time is limited; when the limit is reached your session
                submits as-is. If interrupted, reopening this link resumes it.</li>
            </ul>
          </div>
          <button className="btn-accent" disabled={busy} onClick={begin}>
            {busy ? "Waiting for screen & mic…" : "I'm ready — start and reveal the brief"}
          </button>
          {!busy && (
            <button className="btn-ghost" onClick={() => { setError(""); setStep("details"); }}>
              Go back
            </button>
          )}
          {error && <div className="error-box">{error}</div>}
          <p className="fine">
            Your browser will ask to share your screen — choose <b>Entire Screen</b> —
            then for microphone access. A single tab or window is not accepted.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <div className="card-col">
        <div className="gate-mark">praxis</div>
        <h1>{snap.assessment?.title || DEFAULT_TITLE}</h1>
        <p className="lede">
          Fill in your details below to unlock the assessment. The brief stays
          hidden until you start — the timer begins the moment it is revealed.
        </p>
        <div className="gate-facts">
          <div><dt>Case ID</dt><dd>{snap.caseId}</dd></div>
          <div><dt>Duration</dt><dd>{fmt(snap.duration)}</dd></div>
          <div><dt>Format</dt><dd>Open create + voice</dd></div>
          <div><dt>Tools</dt><dd>Anything, incl. AI</dd></div>
        </div>

        <h2 style={{ fontSize: 17, margin: "0 0 4px" }}>Your details</h2>
        <p style={{ fontSize: 13.5, color: "var(--ink-soft)", marginBottom: 14 }}>
          Your results are linked to these details, so use your real ones.
        </p>
        <div className="field">
          <label htmlFor="g-name">Full name</label>
          <input id="g-name" value={form.name} onChange={set("name")} autoComplete="name" />
        </div>
        <div className="field">
          <label htmlFor="g-upwork">Upwork profile URL</label>
          <input id="g-upwork" type="url" value={form.upwork} onChange={set("upwork")}
            placeholder="https://www.upwork.com/freelancers/~01…" spellCheck="false" />
        </div>
        <div className="field">
          <label htmlFor="g-cv">CV / Résumé (PDF or Word, max 8&nbsp;MB)</label>
          <input id="g-cv" type="file" accept=".pdf,.doc,.docx"
            onChange={(e) => setCvFile(e.target.files?.[0] || null)} />
          {cvFile && !cvOk && (
            <p style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 6 }}>
              Must be a .pdf, .doc, or .docx under 8 MB.
            </p>
          )}
        </div>

        <label className="consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            I consent to my <b>entire screen</b> and <b>microphone</b> being recorded,
            and my interaction with this page (focus changes and timing) being{" "}
            <b>logged</b> for the sole purpose of evaluating this assessment. Recordings
            are reviewed by Praxis assessors and retained no longer than the hiring
            process requires.
          </span>
        </label>
        <button className="btn-accent" disabled={!consent || !detailsComplete}
          onClick={() => setStep("confirm")}>
          Start
        </button>
        <p className="fine">
          Next you will see exactly what happens when the session begins — nothing
          starts and nothing is recorded until you confirm on the following step.
        </p>
      </div>
    </div>
  );
}

function Task({ engine, snap }) {
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef(null);

  function submitClick() {
    if (!confirming) {
      setConfirming(true);
      clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirming(false), 4000);
      return;
    }
    clearTimeout(confirmTimer.current);
    engine.submit();
  }

  const timerClass = snap.phase === "blocked" ? "paused"
    : snap.remaining <= 60 ? "critical"
    : snap.remaining <= 300 ? "warn" : "";

  return (
    <>
      <header className="appbar">
        <div className="bar">
          <div className="wordmark">praxis</div>
          <div className="case-chip">{snap.caseId}</div>
          <div className="spacer" />
          {snap.micLive && <div className="mic-chip" title="Microphone recording">● REC</div>}
          <div className={`timer ${timerClass}`}>
            {snap.phase === "blocked" ? "PAUSED" : fmt(snap.remaining)}
          </div>
        </div>
      </header>

      {snap.phase === "blocked" && <BlockedOverlay engine={engine} snap={snap} />}

      <main className="page assess-open">
        <div className="rules">
          <div><b>Hard stop</b> at 0:00 — session submits automatically.</div>
          <div><b>Any tools permitted</b>, including AI.</div>
          <div><b>Screen + mic required</b> — talk through your thinking.</div>
        </div>

        <section className="brief open-brief">
          <h1>{snap.assessment?.title || DEFAULT_TITLE}</h1>
          <Brief className="open-prompt" text={snap.assessment?.brief} />
        </section>

        <section className="work open-work">
          <button className={`btn-primary ${confirming ? "confirming" : ""}`} onClick={submitClick}>
            {confirming ? `Click again to confirm — ${fmt(snap.remaining)} remains` : "Submit session"}
          </button>
          <p className="submit-note">At 0:00 your session submits automatically.</p>
        </section>
      </main>
      <footer className="foot">praxis · assessment · {snap.caseId}</footer>
    </>
  );
}

function BlockedOverlay({ engine, snap }) {
  const [error, setError] = useState("");
  async function reshare() {
    setError("");
    const result = await engine.reshare();
    if (!result.ok) setError(result.message);
  }
  return (
    <div className="blocked-overlay">
      <div className="inner">
        <div className="mark">■</div>
        <h1>{snap.blockedTitle}</h1>
        <p>The assessment is locked and the timer is paused until you share your <b>entire screen</b> again.</p>
        <p className="pause-budget">Pause budget remaining: {fmt(snap.pauseBudgetLeft)}</p>
        <button className="btn-light" onClick={reshare}>Share entire screen</button>
        {error && <div className="blocked-err">{error}</div>}
      </div>
    </div>
  );
}
