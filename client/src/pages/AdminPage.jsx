import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

export default function AdminPage({ user, onLogout }) {
  const [codes, setCodes] = useState([]);
  const [count, setCount] = useState(5);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    api.adminCodes().then((d) => setCodes(d.codes)).catch((e) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  async function issue() {
    setError("");
    try { await api.adminIssue(Number(count) || 1); refresh(); }
    catch (e) { setError(e.message); }
  }
  async function voidCode(code) {
    if (!window.confirm(`Void code ${code}? The link stops working permanently.`)) return;
    try { await api.adminVoid(code); refresh(); }
    catch (e) { setError(e.message); }
  }

  const link = (code) => `${window.location.origin}/assess?case=${code}`;
  const summary = codes.reduce((acc, c) => ((acc[c.status] = (acc[c.status] || 0) + 1), acc), {});

  return (
    <>
      <header className="appbar">
        <div className="bar wide">
          <div className="wordmark">praxis</div>
          <div className="case-chip">admin</div>
          <div className="spacer" />
          <span style={{ fontSize: 13, color: "var(--ink-faint)" }}>{user.email}</span>
          <button className="btn-small" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <main className="page wide">
        <h1 style={{ fontSize: 22, marginBottom: 6 }}>Assessment sessions</h1>
        <p style={{ color: "var(--ink-soft)", fontSize: 14 }}>
          {Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join(" · ") || "no codes yet"}
        </p>
        <div className="issue-row">
          <input type="number" min="1" max="200" value={count} onChange={(e) => setCount(e.target.value)} />
          <button className="btn-primary" style={{ padding: "9px 18px", fontSize: 14.5 }} onClick={issue}>
            Issue codes
          </button>
        </div>
        {error && <div className="error-box">{error}</div>}
        <table className="admin-table">
          <thead>
            <tr>
              <th>Code</th><th>Candidate link</th><th>Status</th><th>Candidate</th>
              <th>Started</th><th>Submitted</th><th>End</th><th>Frames</th><th>Audio</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {codes.length === 0 && <tr><td colSpan={10}>none yet</td></tr>}
            {codes.map((c) => (
              <tr key={c.code}>
                <td style={{ fontFamily: "var(--mono)" }}>{c.code}</td>
                <td><input readOnly value={link(c.code)} onClick={(e) => e.target.select()} /></td>
                <td><span className={`status-pill status-${c.status}`}>{c.status}</span></td>
                <td>{c.candidate_name ? `${c.candidate_name} <${c.candidate_email}>` : "—"}</td>
                <td style={{ fontSize: 12.5 }}>{c.started_at || "—"}</td>
                <td style={{ fontSize: 12.5 }}>{c.submitted_at || "—"}</td>
                <td>{c.end_reason || "—"}</td>
                <td>{c.frames}</td>
                <td>{c.audio || 0}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {(c.status === "submitted" || c.frames > 0 || (c.audio || 0) > 0) && (
                    <>
                      <Link to={`/admin/case/${c.code}`}>review</Link>{" · "}
                      <a href={`/api/admin/sessions/${c.code}/zip`}>zip</a>
                    </>
                  )}
                  {c.status !== "void" && c.status !== "submitted" && (
                    <>{(c.status === "submitted" || c.frames > 0 || (c.audio || 0) > 0) && " · "}
                      <a href="#" onClick={(e) => { e.preventDefault(); voidCode(c.code); }}>void</a></>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    </>
  );
}
