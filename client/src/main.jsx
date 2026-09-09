import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { api } from "./api.js";
import AuthPage from "./pages/AuthPage.jsx";
import AssessmentPage from "./pages/AssessmentPage.jsx";
import AdminPage from "./pages/AdminPage.jsx";
import CaseReviewPage from "./pages/CaseReviewPage.jsx";
import { ChromeMicSetup } from "./components/ChromeMicSetup.jsx";
import { isGoogleChrome } from "./chrome.js";
import "./styles.css";

function RequireUser({ user, ready, children }) {
  const location = useLocation();
  if (!ready) return null;
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/auth?next=${next}`} replace />;
  }
  return children;
}

function Landing({ user, ready }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [checkingCode, setCheckingCode] = useState(false);
  const [validatedCode, setValidatedCode] = useState("");
  const [micPassed, setMicPassed] = useState(false);
  const validationRef = useRef({ sequence: 0, controller: null });

  useEffect(() => () => {
    validationRef.current.sequence += 1;
    validationRef.current.controller?.abort();
  }, []);

  if (!ready) return null;
  if (user?.role === "admin") return <Navigate to="/admin" replace />;

  function changeCode(e) {
    validationRef.current.sequence += 1;
    validationRef.current.controller?.abort();
    validationRef.current.controller = null;
    setCode(e.target.value);
    setValidatedCode("");
    setMicPassed(false);
    setCheckingCode(false);
    setError("");
  }

  async function validateCode(e) {
    e.preventDefault();
    setError("");
    const clean = code.trim().toUpperCase();
    if (!clean) { setError("Enter the assessment code you were sent."); return; }

    validationRef.current.controller?.abort();
    const controller = new AbortController();
    const sequence = validationRef.current.sequence + 1;
    validationRef.current = { sequence, controller };
    setCheckingCode(true);
    setValidatedCode("");
    setMicPassed(false);

    try {
      let ownerToken = "";
      try { ownerToken = localStorage.getItem("praxis_owner_" + clean) || ""; } catch { /* unavailable storage */ }
      const response = await fetch("/api/assessment/session?case=" + encodeURIComponent(clean), {
        signal: controller.signal,
        headers: ownerToken ? { "X-Assessment-Session": ownerToken } : undefined
      });
      if (!response.ok) throw new Error("request failed");
      const info = await response.json();
      if (validationRef.current.sequence !== sequence) return;

      if (info.status === "active" && info.owned) {
        window.location.href = "/assess?case=" + encodeURIComponent(clean);
        return;
      }

      const messages = {
        unknown: "That code was not recognised — check the exact code you were sent.",
        void: "That code has been disabled. Contact the person who invited you for a new one.",
        active: "That assessment is already in progress in another browser or device. Reopen it where you started, or contact the person who invited you.",
        submitted: "That code has already been used to submit an assessment."
      };
      if (messages[info.status]) {
        setError(messages[info.status]);
        return;
      }
      if (info.status !== "unused") throw new Error("unexpected response");

      setCode(clean);
      setValidatedCode(clean);
    } catch (err) {
      if (err?.name !== "AbortError" && validationRef.current.sequence === sequence) {
        setError("We couldn't check that code. Check your connection and try again.");
      }
    } finally {
      if (validationRef.current.sequence === sequence) {
        validationRef.current.controller = null;
        setCheckingCode(false);
      }
    }
  }

  function continueToAssessment() {
    const clean = code.trim().toUpperCase();
    if (!micPassed || !validatedCode || clean !== validatedCode) {
      setError("Test your microphone and transcription for this code before you continue.");
      return;
    }
    if (!isGoogleChrome()) {
      setError("Open this page in Google Chrome on a computer, then try again.");
      return;
    }
    window.location.href = "/assess?case=" + encodeURIComponent(validatedCode);
  }

  return (
    <div className="screen">
      <div className="card-col">
        <div className="gate-mark">praxis</div>
        <h1>Assessment</h1>
        <p className="lede">
          This assessment must be taken in <b>Google Chrome</b> on a computer,
          with a working microphone. Enter your code first so we can test the
          same transcription service your assessment will use. The timer will
          not start until that check passes again on the next screen.
        </p>
        <form onSubmit={validateCode}>
          <div className="field">
            <label htmlFor="landing-code">Assessment code</label>
            <input id="landing-code" value={code} onChange={changeCode}
              placeholder="e.g. 7K2M9Q" maxLength={6} spellCheck="false" autoComplete="off"
              style={{ fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".12em" }} />
          </div>
          <button className="btn-accent" disabled={checkingCode}>
            {checkingCode ? "Checking assessment code…" : "Check assessment code"}
          </button>
          {error && <div className="error-box">{error}</div>}
        </form>
        {validatedCode && (
          <ChromeMicSetup
            caseId={validatedCode}
            requireTest
            onPassedChange={setMicPassed}
          />
        )}
        <button
          type="button"
          className="btn-accent"
          disabled={!micPassed || !validatedCode || !isGoogleChrome() || code.trim().toUpperCase() !== validatedCode}
          onClick={continueToAssessment}
        >
          Continue to assessment
        </button>
        <p className="fine" style={{ marginTop: 26 }}>
          Praxis staff: <a href="/auth">admin log in</a>
        </p>
      </div>
    </div>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api.me().then((d) => setUser(d.user)).catch(() => {}).finally(() => setReady(true));
  }, []);

  async function logout() {
    await api.logout().catch(() => {});
    setUser(null);
    window.location.href = "/auth";
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage onAuthed={setUser} />} />
        <Route path="/assess" element={<AssessmentPage />} />
        <Route path="/admin" element={
          <RequireUser user={user} ready={ready}>
            {user?.role === "admin" ? <AdminPage user={user} onLogout={logout} /> : <Navigate to="/" replace />}
          </RequireUser>
        } />
        <Route path="/admin/case/:code" element={
          <RequireUser user={user} ready={ready}>
            {user?.role === "admin" ? <CaseReviewPage /> : <Navigate to="/" replace />}
          </RequireUser>
        } />
        <Route path="/" element={<Landing user={user} ready={ready} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")).render(<App />);
