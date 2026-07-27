import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

export default function AdminPage({ user, onLogout }) {
  const [assessments, setAssessments] = useState([]);
  const [codes, setCodes] = useState([]);
  const [error, setError] = useState("");
  const [filterId, setFilterId] = useState("all");

  const refresh = useCallback(() => {
    api.adminAssessments().then((d) => setAssessments(d.assessments)).catch((e) => setError(e.message));
    api.adminCodes().then((d) => setCodes(d.codes)).catch((e) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  const visibleCodes = useMemo(
    () => (filterId === "all" ? codes : codes.filter((c) => String(c.assessment_id || "") === String(filterId))),
    [codes, filterId]
  );
  const summary = visibleCodes.reduce((acc, c) => ((acc[c.status] = (acc[c.status] || 0) + 1), acc), {});
  const link = (code) => `${window.location.origin}/assess?case=${code}`;

  async function voidCode(code) {
    if (!window.confirm(`Void code ${code}? The link stops working permanently.`)) return;
    try { await api.adminVoid(code); refresh(); }
    catch (e) { setError(e.message); }
  }

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
        {error && <div className="error-box">{error}</div>}

        <AssessmentsPanel assessments={assessments} setError={setError} refresh={refresh} />

        <h1 style={{ fontSize: 22, margin: "36px 0 6px" }}>Issued codes</h1>
        <p style={{ color: "var(--ink-soft)", fontSize: 14 }}>
          {Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join(" · ") || "no codes yet"}
        </p>
        <div className="issue-row">
          <label style={{ fontSize: 13, fontWeight: 700 }}>Show</label>
          <select value={filterId} onChange={(e) => setFilterId(e.target.value)} style={{ padding: "8px 10px" }}>
            <option value="all">All assessments</option>
            {assessments.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        </div>
        <table className="admin-table">
          <thead>
            <tr>
              <th>Code</th><th>Assessment</th><th>Candidate link</th><th>Status</th><th>Candidate</th>
              <th>Started</th><th>Submitted</th><th>End</th><th>Frames</th><th>Audio</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleCodes.length === 0 && <tr><td colSpan={11}>none yet</td></tr>}
            {visibleCodes.map((c) => (
              <tr key={c.code}>
                <td style={{ fontFamily: "var(--mono)" }}>{c.code}</td>
                <td>{c.assessment_title || "—"}</td>
                <td><input readOnly value={link(c.code)} onClick={(e) => e.target.select()} /></td>
                <td><span className={`status-pill status-${c.status}`}>{c.status}</span></td>
                <td>
                  {c.candidate_name
                    ? c.candidate_linkedin
                      ? <a href={c.candidate_linkedin} target="_blank" rel="noreferrer">{c.candidate_name}</a>
                      : c.candidate_email
                        ? `${c.candidate_name} <${c.candidate_email}>`
                        : c.candidate_name
                    : "—"}
                </td>
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

function AssessmentsPanel({ assessments, setError, refresh }) {
  const [editing, setEditing] = useState(null); // {id, title, brief} or null; id=null means "new"
  const [issuing, setIssuing] = useState(null);  // assessment id currently showing an issue-count input
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);

  function startNew() { setEditing({ id: null, title: "", brief: "", durationMinutes: 15 }); }
  function startEdit(a) { setEditing({ id: a.id, title: a.title, brief: a.brief, durationMinutes: a.duration_minutes }); }
  function cancelEdit() { setEditing(null); }

  async function save() {
    if (!editing.title.trim()) { setError("Give the assessment a title."); return; }
    const duration = Number(editing.durationMinutes);
    if (!Number.isInteger(duration) || duration < 1 || duration > 180) {
      setError("Duration must be 1-180 minutes.");
      return;
    }
    setBusy(true);
    setError("");
    const body = { title: editing.title, brief: editing.brief, durationMinutes: duration };
    try {
      if (editing.id) await api.adminUpdateAssessment(editing.id, body);
      else await api.adminCreateAssessment(body);
      setEditing(null);
      refresh();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function remove(a) {
    if (!window.confirm(`Delete "${a.title}"? This only works if no codes have been issued under it.`)) return;
    try { await api.adminDeleteAssessment(a.id); refresh(); }
    catch (e) { setError(e.message); }
  }

  async function issue(a) {
    setError("");
    try { await api.adminIssue(Number(count) || 1, a.id); setIssuing(null); refresh(); }
    catch (e) { setError(e.message); }
  }

  return (
    <section>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ fontSize: 22, marginBottom: 6 }}>Assessments</h1>
        <div className="spacer" />
        {!editing && (
          <button className="btn-primary" style={{ padding: "9px 18px", fontSize: 14.5 }} onClick={startNew}>
            New assessment
          </button>
        )}
      </div>
      <p style={{ color: "var(--ink-soft)", fontSize: 14, marginBottom: 16 }}>
        Write up the brief for a candidate, save it, then issue codes under it — each code hands that
        candidate this exact brief.
      </p>

      {editing && (
        <div style={{ border: "1px solid var(--line)", padding: 18, marginBottom: 20, background: "var(--raised)" }}>
          <div className="field">
            <label htmlFor="a-title">Title</label>
            <input
              id="a-title"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              placeholder="e.g. Senior React — build task"
            />
          </div>
          <div className="field" style={{ maxWidth: 160 }}>
            <label htmlFor="a-duration">Duration (minutes)</label>
            <input
              id="a-duration"
              type="number"
              min="1"
              max="180"
              value={editing.durationMinutes}
              onChange={(e) => setEditing({ ...editing, durationMinutes: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="a-brief">Brief (shown to the candidate — separate paragraphs with a blank line)</label>
            <textarea
              id="a-brief"
              style={{ minHeight: 260 }}
              value={editing.brief}
              onChange={(e) => setEditing({ ...editing, brief: e.target.value })}
              placeholder="Create something from nothing. Use this time however you need — build, research, draft, prototype..."
            />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn-primary" style={{ padding: "9px 18px", fontSize: 14.5 }} disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn-small" onClick={cancelEdit}>Cancel</button>
          </div>
        </div>
      )}

      {assessments.length === 0 && !editing && (
        <p style={{ color: "var(--ink-faint)", fontSize: 14 }}>No assessments yet — create one to start issuing codes.</p>
      )}

      {assessments.map((a) => (
        <div key={a.id} style={{ border: "1px solid var(--line)", padding: "14px 16px", marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <b style={{ fontSize: 15.5 }}>{a.title}</b>
            <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>
              {a.duration_minutes} min · {a.code_count} code{a.code_count === 1 ? "" : "s"} issued
              · updated {a.updated_at?.slice(0, 10)}
            </span>
            <div className="spacer" />
            <button className="btn-small" onClick={() => startEdit(a)}>Edit</button>
            <button className="btn-small" onClick={() => setIssuing(issuing === a.id ? null : a.id)}>Issue codes</button>
            {a.code_count === 0 && <button className="btn-small" onClick={() => remove(a)}>Delete</button>}
          </div>
          {issuing === a.id && (
            <div className="issue-row">
              <input type="number" min="1" max="200" value={count} onChange={(e) => setCount(e.target.value)} />
              <button className="btn-primary" style={{ padding: "9px 18px", fontSize: 14.5 }} onClick={() => issue(a)}>
                Issue
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
