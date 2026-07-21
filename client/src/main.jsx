import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { api } from "./api.js";
import AuthPage from "./pages/AuthPage.jsx";
import AssessmentPage from "./pages/AssessmentPage.jsx";
import AdminPage from "./pages/AdminPage.jsx";
import CaseReviewPage from "./pages/CaseReviewPage.jsx";
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
  if (!ready) return null;
  if (user?.role === "admin") return <Navigate to="/admin" replace />;

  async function go(e) {
    e.preventDefault();
    setError("");
    const clean = code.trim().toUpperCase();
    if (!clean) { setError("Enter the assessment code you were sent."); return; }
    const info = await fetch("/api/assessment/session?case=" + encodeURIComponent(clean))
      .then((r) => r.json()).catch(() => ({ status: "unknown" }));
    const messages = {
      unknown: "That code was not recognised — check the exact code you were sent.",
      void: "That code has been disabled. Contact the person who invited you for a new one.",
      submitted: "That code has already been used to submit an assessment."
    };
    if (messages[info.status]) { setError(messages[info.status]); return; }
    window.location.href = "/assess?case=" + clean;
  }

  return (
    <div className="screen">
      <div className="card-col narrow">
        <div className="gate-mark">praxis</div>
        <h1>Assessment</h1>
        <p className="lede">
          Enter the unique assessment code you were sent. You'll fill in your
          details on the next screen — no account needed.
        </p>
        <form onSubmit={go}>
          <div className="field">
            <label htmlFor="landing-code">Assessment code</label>
            <input id="landing-code" value={code} onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. 7K2M9Q" maxLength={6} spellCheck="false" autoComplete="off"
              style={{ fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: ".12em" }} />
          </div>
          <button className="btn-accent">Continue to assessment</button>
          {error && <div className="error-box">{error}</div>}
        </form>
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
