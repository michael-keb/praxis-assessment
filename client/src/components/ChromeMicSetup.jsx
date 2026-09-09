import { useEffect, useRef, useState } from "react";
import { createEngine } from "../engine.js";
import { isGoogleChrome } from "../chrome.js";

const PHRASE = "My microphone is working and I am ready to begin.";
const EMPTY_SNAPSHOT = {
  micCheck: "idle",
  transcript: { tail: [], interim: "" }
};

export function ChromeMicSetup({ caseId = "", requireTest = false, onPassedChange }) {
  const chrome = isGoogleChrome();
  const normalizedCaseId = String(caseId || "").trim().toUpperCase();
  const engineRef = useRef(null);
  const runRef = useRef(0);
  const runningRef = useRef(false);
  const [session, setSession] = useState({ caseId: "", engine: null, snapshot: EMPTY_SNAPSHOT });
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    runRef.current += 1;
    runningRef.current = false;
    setTesting(false);
    setError("");

    if (!normalizedCaseId) {
      engineRef.current = null;
      setSession({ caseId: "", engine: null, snapshot: EMPTY_SNAPSHOT });
      return undefined;
    }

    const engine = createEngine(normalizedCaseId, { preflightOnly: true });
    let active = true;
    engineRef.current = engine;

    const publish = () => {
      if (active) setSession({ caseId: normalizedCaseId, engine, snapshot: engine.snapshot() });
    };
    const unsubscribe = engine.subscribe(publish);
    publish();

    return () => {
      active = false;
      runRef.current += 1;
      runningRef.current = false;
      if (engineRef.current === engine) engineRef.current = null;
      unsubscribe();
      engine.destroy();
    };
  }, [normalizedCaseId]);

  const currentSession = session.caseId === normalizedCaseId;
  const snapshot = currentSession ? session.snapshot : EMPTY_SNAPSHOT;
  const status = snapshot.micCheck || "idle";
  const passed = Boolean(normalizedCaseId && currentSession && status === "passed");
  const heard = [
    ...(snapshot.transcript?.tail || []),
    snapshot.transcript?.interim
  ].filter(Boolean).join(" ");

  useEffect(() => {
    onPassedChange?.(passed);
  }, [onPassedChange, passed]);

  async function runTest() {
    const engine = engineRef.current;
    if (!engine || runningRef.current) return;

    setError("");
    if (!isGoogleChrome()) {
      setError("Open this page in Google Chrome on a computer. Other browsers cannot run this assessment.");
      return;
    }

    const run = ++runRef.current;
    runningRef.current = true;
    setTesting(true);
    try {
      const result = await engine.testMicrophone();
      if (run !== runRef.current || engineRef.current !== engine) return;
      if (!result.ok) {
        setError(result.message || "Could not connect your microphone and transcription. Check your connection, then try again.");
      }
    } catch {
      if (run === runRef.current && engineRef.current === engine) {
        setError("Could not connect your microphone and transcription. Check your connection, then try again.");
      }
    } finally {
      if (run === runRef.current && engineRef.current === engine) {
        runningRef.current = false;
        setTesting(false);
      }
    }
  }

  const checking = status === "checking";
  const connecting = testing && !checking && !passed;
  const busy = testing || checking;
  const buttonLabel = connecting
    ? "Connecting transcription…"
    : checking
      ? "Listening — say the sentence now…"
      : passed
        ? "Microphone and transcription passed"
        : "Test microphone and transcription";

  return (
    <div className="chrome-setup">
      {!chrome && (
        <div className="error-box" role="alert">
          This assessment only works in <b>Google Chrome</b> on a computer.
          Safari, Firefox, Edge, Brave, and phone browsers will fail the microphone
          or screen-share check. Copy this link and open it in Chrome.
        </div>
      )}

      <div className="gate-warning chrome-steps">
        <b>Use Google Chrome, and set the microphone up before you begin.</b>
        <ol>
          <li>Open this exact link in <b>Google Chrome</b> (the Chrome app, not Safari or a messaging-app browser).</li>
          <li>Click the <b>padlock</b> or tune icon to the left of the address bar.</li>
          <li>Open <b>Site settings</b>. Set <b>Microphone</b> to <b>Allow</b>.</li>
          <li>If it is blocked: Chrome menu → <b>Settings</b> → <b>Privacy and security</b> → <b>Site settings</b> → <b>Microphone</b>. Allow this site, and pick the headset or mic you will use.</li>
          <li>On a Mac: <b>System Settings</b> → <b>Privacy &amp; Security</b> → <b>Microphone</b> → turn on <b>Google Chrome</b>.</li>
          <li>Close Zoom, Teams, Meet, or any recorder that might be holding the mic.</li>
        </ol>
        <p className="chrome-reconnect">
          Do not unplug, mute, or switch your microphone during the assessment.
          Reconnecting mid-test locks the page, pauses the timer, and spends your
          pause budget. You then have to pass a spoken check before you can continue.
        </p>
      </div>

      <div className="mic-preflight">
        <button
          type="button"
          className="btn-ghost"
          disabled={!chrome || !currentSession || !session.engine || busy}
          onClick={runTest}
        >
          {buttonLabel}
        </button>
        {checking && (
          <p className="fine" role="status">
            Allow microphone access if Chrome asks. Then say: <b>“{PHRASE}”</b>
            Keep speaking until the words appear below.
          </p>
        )}
        {(heard || checking) && (
          <p className="mic-heard" aria-live="polite">
            <span>Heard:</span> {heard || "…"}
          </p>
        )}
        {error && <div className="error-box" role="alert">{error}</div>}
        {!normalizedCaseId && (
          <p className="fine">Enter and validate your assessment code before testing transcription.</p>
        )}
        {requireTest && !passed && normalizedCaseId && (
          <p className="fine">Pass this check before you continue. The assessment will test transcription again when the timer is about to start.</p>
        )}
      </div>
    </div>
  );
}
