import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";
import { createEngine, DURATION } from "../engine.js";

const fmt = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

const ZONES = [
  { n: "1", title: "Read of the numbers", hint: "What do these figures actually say? Show any arithmetic that matters." },
  { n: "2", title: "What the evidence can and can't support", hint: "Where do these numbers come from, and what would you want to know before trusting them?" },
  { n: "3", title: "Your call", hint: "Sign off or not — commit to a position and justify it." },
  { n: "4", title: "What you'd do next", hint: "Whatever your call — what would you change about this system, and how would you find out if you were wrong?" }
];

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
      "The timer reached zero. Whatever you had written was submitted automatically, along with your session trace. You may close this tab."],
    pause_limit: ["⏱", "Pause limit reached",
      "Screen sharing was paused for longer than the allowed limit, so your work was submitted as-is along with your session trace. You may close this tab."]
  }[reason] || ["✓", "Response submitted",
    "Thank you. Your response and session trace have been recorded. You may close this tab."];
  return <CenterScreen mark={copy[0]} title={copy[1]} text={copy[2]} />;
}

function Gate({ engine, snap }) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", email: "", upwork: "" });

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const detailsComplete =
    form.name.trim() &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) &&
    /^https?:\/\/(www\.)?upwork\.com\/.+/i.test(form.upwork.trim());

  async function begin() {
    setBusy(true);
    setError("");
    const result = await engine.begin({
      name: form.name.trim(),
      email: form.email.trim(),
      upwork: form.upwork.trim()
    });
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <div className="card-col">
        <div className="gate-mark">Prax<span>is</span></div>
        <h1>Reasoning Assessment</h1>
        <p className="lede">
          One problem. Fifteen minutes on a hard timer, starting the moment sharing
          begins. You may use any tools you like — including AI assistants. We are
          assessing how you reason, not what you can look up.
        </p>
        <div className="gate-facts">
          <div><dt>Case ID</dt><dd>{snap.caseId}</dd></div>
          <div><dt>Duration</dt><dd>{fmt(DURATION)}</dd></div>
          <div><dt>Format</dt><dd>4 written responses</dd></div>
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
          <label htmlFor="g-email">Email</label>
          <input id="g-email" type="email" value={form.email} onChange={set("email")} autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="g-upwork">Upwork profile URL</label>
          <input id="g-upwork" type="url" value={form.upwork} onChange={set("upwork")}
            placeholder="https://www.upwork.com/freelancers/~01…" spellCheck="false" />
        </div>

        <label className="consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            I consent to my <b>entire screen being recorded</b> and my interaction with
            this page (typing, pasting, focus changes, and timing) being <b>logged</b> for
            the sole purpose of evaluating this assessment. Recordings are reviewed by
            Praxis assessors and retained no longer than the hiring process requires.
          </span>
        </label>
        <button className="btn-accent" disabled={!consent || !detailsComplete || busy} onClick={begin}>
          {busy ? "Waiting for screen share…" : "Begin — share your entire screen"}
        </button>
        {error && <div className="error-box">{error}</div>}
        <p className="fine">
          Your browser will ask you to share your screen — choose <b>Entire Screen</b>.
          A single tab or window is not accepted. The assessment only runs while sharing
          is active: if sharing stops, the page locks and the timer pauses. Total pause
          time is limited; when the limit is reached your work submits as-is. If your
          session is interrupted, reopening this link resumes it.
        </p>
      </div>
    </div>
  );
}

function Task({ engine, snap }) {
  const briefRef = useRef(null);
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef(null);

  useEffect(() => {
    engine.observeBrief(briefRef.current);
  }, [engine]);

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
          <div className="wordmark">Prax<span>is</span></div>
          <div className="case-chip">{snap.caseId}</div>
          <div className="spacer" />
          <div className={`timer ${timerClass}`}>
            {snap.phase === "blocked" ? "PAUSED" : fmt(snap.remaining)}
          </div>
        </div>
      </header>

      {snap.phase === "blocked" && <BlockedOverlay engine={engine} snap={snap} />}

      <main className="page">
        <div className="rules">
          <div><b>Hard stop</b> at 0:00 — whatever is written is submitted.</div>
          <div><b>Any tools permitted</b>, including AI.</div>
          <div><b>Sharing required</b> — timer pauses if sharing stops.</div>
        </div>

        <section className="brief" ref={briefRef}>
          <h1>Sign-off request: raising the urgency threshold</h1>
          <p>
            You are the engineer on rotation for <b>Meridian</b>, an incident-triage
            system your team owns. Every alert produced by the monitoring stack is
            scored by a classifier and routed to one of two tiers:
          </p>
          <ul>
            <li><b>Urgent</b> — pages the on-call engineer. A human confirms or dismisses the alert, typically within <b>5 minutes</b> of it firing.</li>
            <li><b>Routine</b> — enters a queue reviewed in the next business day's sweep, typically <b>~24 hours</b> after the alert fired.</li>
          </ul>
          <p>
            Whatever the reviewer concludes becomes the alert's outcome label. The
            classifier is <b>retrained monthly on these outcome labels</b>. It has been
            in production for six months, retrained each month since launch.
          </p>
          <div className="figures">
            <table>
              <tbody>
                <tr><th>Last month</th><th>Volume</th><th>Confirmed real</th><th>Rate</th></tr>
                <tr><td>Routed urgent</td><td>3,200</td><td>1,280</td><td>40%</td></tr>
                <tr><td>Routed routine</td><td>36,800</td><td>736</td><td>2%</td></tr>
              </tbody>
            </table>
            <p className="note">
              Since launch, urgent-tier precision has climbed from 31% to 40%. The
              routine tier's rate has held steady at ~2% throughout.
            </p>
          </div>
          <p>
            On-call load is a real problem — pages are up, and the team is tired.
            Leadership proposes <b>raising the urgency threshold</b> so roughly 40%
            fewer alerts route urgent. Their case:
          </p>
          <div className="quote">
            "The routine tier's miss rate is only 2%, and it's been flat for six
            months. Precision on urgent keeps improving. Even if some borderline
            alerts move down a tier, the data says they'll be fine — and the next
            retrain will pick up any slack."
          </div>
          <p className="ask">
            The change ships before the next monthly retrain unless you object. You
            are asked to sign off. Do you? Work through it in the four zones below.
          </p>
        </section>

        <section className="work">
          {ZONES.map((zone) => (
            <div className="zone" key={zone.n}>
              <div className="zone-head">
                <span className="zone-num">ZONE {zone.n}</span>
                <span className="zone-title">{zone.title}</span>
              </div>
              <div className="zone-hint">{zone.hint}</div>
              <textarea
                value={snap.zones[zone.n]}
                placeholder="Write here…"
                onChange={(e) => engine.setZone(zone.n, e.target.value)}
                onFocus={() => engine.zoneFocus(zone.n)}
                onBlur={() => engine.zoneBlur(zone.n)}
                onPaste={(e) => engine.zonePaste(zone.n, (e.clipboardData?.getData("text") || "").length)}
                onCut={(e) => engine.zoneCut(zone.n, (e.target.selectionEnd || 0) - (e.target.selectionStart || 0))}
              />
              <div className="zone-meta">{snap.zones[zone.n].length} chars</div>
            </div>
          ))}

          <fieldset>
            <legend>How confident are you in your call?</legend>
            <div className="conf-row">
              {["low", "moderate", "high"].map((level) => (
                <label key={level}>
                  <input type="radio" name="confidence" value={level}
                    checked={snap.confidence === level}
                    onChange={() => engine.setConfidence(level)} />
                  {level[0].toUpperCase() + level.slice(1)}
                </label>
              ))}
            </div>
          </fieldset>

          <button className={`btn-primary ${confirming ? "confirming" : ""}`}
            disabled={!snap.confidence} onClick={submitClick}>
            {confirming ? `Click again to confirm — ${fmt(snap.remaining)} remains` : "Submit response"}
          </button>
          <p className="submit-note">
            {snap.confidence
              ? "At 0:00 your response submits automatically."
              : "Select a confidence level to submit. At 0:00 your response submits automatically."}
          </p>
        </section>
      </main>
      <footer className="foot">Praxis · Reasoning Assessment · {snap.caseId}</footer>
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
