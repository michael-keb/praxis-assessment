import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router-dom";
import { createEngine } from "../engine.js";
import BriefContent from "../components/BriefContent.jsx";
import { ChromeMicSetup } from "../components/ChromeMicSetup.jsx";
import { isGoogleChrome } from "../chrome.js";
import { normalizeProfileUrl } from "../profile-url.js";

const fmt = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

const DEFAULT_TITLE = "Assessment";

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
  if (snap.phase === "fatal") return <CenterScreen mark="⚠" title={snap.fatal.title} text={snap.fatal.text}
    action={snap.fatal.retryable && <button className="btn-accent" onClick={() => engine.boot()}>Retry connection</button>} />;
  if (snap.phase === 'submitting') return <SavingScreen engine={engine} snap={snap} />;
  if (snap.phase === "done") return <DoneScreen reason={snap.doneReason} />;
  if (snap.phase === "gate") return <Gate engine={engine} snap={snap} />;
  return <Task engine={engine} snap={snap} />;
}

function CenterScreen({ mark, title, text, action }) {
  return (
    <div className="center-screen">
      <div className="mark">{mark}</div>
      <h1>{title}</h1>
      <p style={{ maxWidth: 480, margin: "0 auto" }}>{text}</p>
      {action && <div style={{ maxWidth: 480, margin: '24px auto 0', padding: '0 20px' }}>{action}</div>}
    </div>
  );
}

function SavingScreen({ engine, snap }) {
  return <CenterScreen mark="…" title="Saving your session"
    text={snap.submissionError || 'Your screen and microphone are stopped. Keep this tab open while your transcript and recording finish saving.'}
    action={<>
      {snap.pendingFrames > 0 && <p role="status">Your recording is still uploading.</p>}
      {snap.submissionError && <button className="btn-accent" onClick={() => engine.retrySubmit()}>Retry saving</button>}
    </>} />;
}

function DoneScreen({ reason }) {
  const copy = {
    expired: ["⏱", "Time expired",
      "The timer reached zero. Your screen recording and voice transcript were submitted. You may close this tab."],
    pause_limit: ["⏱", "Pause limit reached",
      "Screen sharing was paused for longer than the allowed limit, so your session was submitted as-is. You may close this tab."]
  }[reason] || ["✓", "Session submitted",
    "Thank you. Your screen recording and voice transcript have been submitted. You may close this tab."];
  return <CenterScreen mark={copy[0]} title={copy[1]} text={copy[2]} />;
}

function Gate({ engine, snap }) {
  const [step, setStep] = useState("details");   // details | confirm
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", linkedin: "", upwork: "" });
  const [cvFile, setCvFile] = useState(null);
  const [portfolioFiles, setPortfolioFiles] = useState([]);

  const gate = snap.assessment?.gateFields || { linkedin: true, upwork: false, cv: false, portfolio: false };
  const set = (key) => (e) => {
    const value = e.target.value;
    setForm(previous => ({ ...previous, [key]: value }));
  };
  const linkedin = normalizeProfileUrl(form.linkedin.trim(), 'linkedin');
  const upwork = normalizeProfileUrl(form.upwork.trim(), 'upwork');
  const linkedinInvalid = !!form.linkedin.trim() && !linkedin;
  const upworkInvalid = !!form.upwork.trim() && !upwork;
  const normalizeOnBlur = (key) => () => setForm(previous => ({
    ...previous, [key]: normalizeProfileUrl(previous[key].trim(), key) || previous[key],
  }));

  const cvOk = !gate.cv || (cvFile && /\.(pdf|doc|docx)$/i.test(cvFile.name) && cvFile.size <= 8 * 1024 * 1024);
  const IMAGE_OK = /\.(jpe?g|png|webp)$/i;
  const portfolioOk = !gate.portfolio || (
    portfolioFiles.length >= 1 &&
    portfolioFiles.length <= 10 &&
    portfolioFiles.every((f) => IMAGE_OK.test(f.name) && f.size <= 8 * 1024 * 1024)
  );
  const detailsComplete =
    form.name.trim() &&
    (!gate.linkedin || linkedin) &&
    (!gate.upwork || upwork) &&
    cvOk &&
    portfolioOk;

  async function begin() {
    setBusy(true);
    setError("");
    const result = await engine.begin({
      name: form.name.trim(),
      linkedin: gate.linkedin ? linkedin : "",
      upwork: gate.upwork ? upwork : "",
      cvFile: gate.cv ? cvFile : null,
      portfolioFiles: gate.portfolio ? portfolioFiles : [],
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
            First you will share your entire screen, then we will confirm live
            transcription. After the checks pass and your start is confirmed, the brief will appear and
            the clock start. Stay in Google Chrome and do not unplug or switch
            your microphone once you begin.
          </p>
          <div className="gate-warning">
            <ul>
              <li><b>The timer starts when your brief appears.</b> You will have {fmt(snap.duration)},
                with a hard stop at 0:00 — your session submits automatically, finished or not.</li>
              <li><b>This code is single-use.</b> Once started there is no restart and no
                fresh timer. Only begin when you are ready to spend the full time now.</li>
              <li><b>Your entire screen is recorded and your voice is transcribed
                live</b> for the whole session — the transcript appears on screen as
                you speak. Think out loud the entire time.</li>
              <li><b>Do not reconnect, mute, or switch your microphone</b> during the
                test. That locks the page, pauses the timer, and spends pause budget.</li>
              <li><b>Stopping the share pauses and locks the page</b> — not the assessment.
                Total pause time is limited; when the limit is reached your session
                submits as-is. If interrupted, reopening this link resumes it.</li>
            </ul>
          </div>
          <button className="btn-accent" disabled={busy || !isGoogleChrome()} onClick={begin}>
            {busy ? (snap.micCheck === "checking" ? "Listening — say a sentence now…" : "Connecting…") : "Check microphone and start"}
          </button>
          {busy && snap.micCheck === "checking" && (
            <div className="gate-warning" role="status" aria-live="polite">
              <b>Say: “My microphone is working and I am ready to begin.”</b>
              <p>Keep speaking until your words appear below. The timer has not started and your code has not been used. Allow microphone access if prompted.</p>
              <p className="mic-heard"><span>Heard:</span> {[...(snap.transcript?.tail || []), snap.transcript?.interim].filter(Boolean).join(" ") || "…"}</p>
            </div>
          )}
          {!busy && (
            <button className="btn-ghost" onClick={() => { setError(""); setStep("details"); }}>
              Go back
            </button>
          )}
          {error && <div className="error-box">{error}</div>}
          {!isGoogleChrome() && (
            <div className="error-box">Open this page in Google Chrome on a computer. Other browsers cannot complete the microphone check.</div>
          )}
          <p className="fine">
            Your browser will ask to share your screen — choose <b>Entire Screen</b> —
            then for microphone access. Speak the test sentence when prompted.
            A single tab or window is not accepted.
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
          Fill in your details below to unlock the assessment. Use{" "}
          <b>Google Chrome</b> on a computer. The brief stays hidden until you
          start — the timer begins after the checks pass and your start is confirmed.
        </p>
        <ChromeMicSetup caseId={snap.caseId} />
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
        {gate.linkedin && (
          <div className="field">
            <label htmlFor="g-linkedin">LinkedIn profile URL</label>
            <input id="g-linkedin" type="url" value={form.linkedin} onChange={set("linkedin")}
              onBlur={normalizeOnBlur('linkedin')} aria-invalid={linkedinInvalid}
              aria-describedby={linkedinInvalid ? 'g-linkedin-error' : undefined}
              placeholder="https://www.linkedin.com/in/…" spellCheck="false" />
            {linkedinInvalid && <p id="g-linkedin-error" style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 6 }}>
              Enter a valid LinkedIn profile URL, such as linkedin.com/in/your-name.
            </p>}
          </div>
        )}
        {gate.upwork && (
          <div className="field">
            <label htmlFor="g-upwork">Upwork profile URL</label>
            <input id="g-upwork" type="url" value={form.upwork} onChange={set("upwork")}
              onBlur={normalizeOnBlur('upwork')} aria-invalid={upworkInvalid}
              aria-describedby={upworkInvalid ? 'g-upwork-error' : undefined}
              placeholder="https://www.upwork.com/freelancers/~01…" spellCheck="false" />
            {upworkInvalid && <p id="g-upwork-error" style={{ fontSize: 12.5, color: 'var(--danger)', marginTop: 6 }}>
              Enter a valid Upwork profile URL, such as upwork.com/freelancers/~your-id.
            </p>}
          </div>
        )}
        {gate.cv && (
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
        )}
        {gate.portfolio && (
          <div className="field">
            <label htmlFor="g-portfolio">Image portfolio (JPG, PNG or WebP, 1–10 images, max 8&nbsp;MB each)</label>
            <input id="g-portfolio" type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" multiple
              onChange={(e) => setPortfolioFiles([...e.target.files || []].slice(0, 10))} />
            {portfolioFiles.length > 0 && (
              <ul style={{ fontSize: 12.5, margin: "8px 0 0", paddingLeft: 18, color: "var(--ink-soft)" }}>
                {portfolioFiles.map((f) => <li key={f.name + f.size}>{f.name}</li>)}
              </ul>
            )}
            {portfolioFiles.length > 0 && !portfolioOk && (
              <p style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 6 }}>
                Each file must be a JPG, PNG, or WebP under 8 MB (1–10 images).
              </p>
            )}
          </div>
        )}

        <label className="consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            I consent to my <b>entire screen</b> being recorded, my voice being{" "}
            <b>transcribed in real time</b> (the transcript is shown on screen and
            stored; no audio recording is kept), and my interaction with this page
            (focus changes and timing) being <b>logged</b> for the sole purpose of
            evaluating this assessment. Records are reviewed by Praxis assessors and
            retained no longer than the hiring process requires.
          </span>
        </label>
        <button className="btn-accent" disabled={!consent || !detailsComplete || !isGoogleChrome()}
          onClick={() => setStep("confirm")}>
          Start
        </button>
        {!isGoogleChrome() && (
          <div className="error-box">Open this page in Google Chrome on a computer before you start.</div>
        )}
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
    // A native confirmation is a second, independent user gesture. It also
    // prevents a delayed click/Enter event from the screen or microphone
    // permission flow from submitting the newly revealed task.
    if (window.confirm("Submit this assessment now? You will not be able to continue after submission.")) {
      engine.submit();
    } else {
      setConfirming(false);
    }
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
          {snap.reconnecting && <div className="mic-chip mic-warn" role="status">Reconnecting transcript…</div>}
          {snap.micLive && !snap.micSilent && !snap.reconnecting && <div className="mic-chip" title="Live transcription running">● TRANSCRIBING</div>}
          {snap.micLive && snap.micSilent && <div className="mic-chip mic-warn" title="Nothing heard recently">⚠ CAN'T HEAR YOU</div>}
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
          <div><b>Talk through your thinking</b> — your words are transcribed live below.</div>
        </div>

        <section className="brief open-brief">
          <h1>{snap.assessment?.title || DEFAULT_TITLE}</h1>
          <BriefContent text={snap.assessment?.brief} />
        </section>

        <section className="work open-work">
          <button className={`btn-primary ${confirming ? "confirming" : ""}`} onClick={submitClick}>
            {confirming ? `Click again to confirm — ${fmt(snap.remaining)} remains` : "Submit session"}
          </button>
          <p className="submit-note">At 0:00 your session submits automatically.</p>
        </section>
      </main>

      <div className={`caption-bar ${snap.micSilent ? "silent" : ""}`}>
        <span className="cap-label">{snap.micSilent ? "⚠ CAN'T HEAR YOU" : "LIVE TRANSCRIPT"}</span>
        <span className="cap-text">
          {snap.micSilent
            ? "Nothing heard for a while — check your microphone is the right one and keep talking through your thinking."
            : [...(snap.transcript?.tail || []).slice(-2), snap.transcript?.interim].filter(Boolean).join(" ") ||
              "Start talking — your words appear here as you speak."}
        </span>
      </div>

      <footer className="foot">praxis · assessment · {snap.caseId}</footer>
    </>
  );
}

function BlockedOverlay({ engine, snap }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function reshare() {
    setError("");
    setBusy(true);
    const result = await engine.reshare();
    setBusy(false);
    if (!result.ok) setError(result.message);
  }
  return (
    <div className="blocked-overlay">
      <div className="inner">
        <div className="mark">■</div>
        <h1>{snap.blockedTitle}</h1>
        <p>
          {snap.blockedTitle === 'Recording storage interrupted'
            ? <>Your recording could not be saved. Check your available device storage, then reconnect to continue. Your timer is paused.</>
            : snap.blockedTitle === 'Transcription disconnected'
            ? <>Live transcription could not reconnect. Check your internet connection, then reconnect and speak the test sentence. Your timer is paused.</>
            : snap.screenLive
            ? <>The assessment is locked and the timer is paused until your <b>microphone</b> is connected and we hear you through live transcription. Stay in Google Chrome. Do not keep unplugging or switching the mic — that spends pause budget.</>
            : <>The assessment is locked and the timer is paused until you share your <b>entire screen</b> and pass the microphone check. Stay in Google Chrome.</>}
        </p>
        <p className="pause-budget">Pause budget remaining: {fmt(snap.pauseBudgetLeft)}</p>
        <button className="btn-light" disabled={busy} onClick={reshare}>
          {busy ? (snap.micCheck === "checking" ? "Listening — say a sentence now…" : "Connecting…") : snap.screenLive ? "Check microphone and continue" : "Share screen and check microphone"}
        </button>
        {busy && snap.micCheck === "checking" && (
          <p role="status">
            Say: “My microphone is working and I am ready to continue.” Keep speaking until your words appear:{" "}
            <b>{[...(snap.transcript?.tail || []), snap.transcript?.interim].filter(Boolean).join(" ") || "…"}</b>
          </p>
        )}
        {error && <div className="blocked-err">{error}</div>}
      </div>
    </div>
  );
}
