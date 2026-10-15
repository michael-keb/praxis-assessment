import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CODE_COLUMNS, formatTimestamp, nextSort, sortByColumn } from "../admin-table-sort.js";
import { api } from "../api.js";
import { ReqopsLockup } from "../components/ReqopsMark.jsx";

const BriefEditor = lazy(() => import("../components/BriefEditor.jsx"));

export default function AdminPage({ user, onLogout }) {
  const [assessments, setAssessments] = useState([]);
  const [codes, setCodes] = useState([]);
  const [error, setError] = useState("");
  const [filterId, setFilterId] = useState("all");
  const [sort, setSort] = useState({ key: null, dir: "asc" });

  const refresh = useCallback(() => {
    api.adminAssessments().then((d) => setAssessments(d.assessments)).catch((e) => setError(e.message));
    api.adminCodes().then((d) => setCodes(d.codes)).catch((e) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);

  const visibleCodes = useMemo(
    () => (filterId === "all" ? codes : codes.filter((c) => String(c.assessment_id || "") === String(filterId))),
    [codes, filterId]
  );
  const sortedCodes = useMemo(() => {
    const column = CODE_COLUMNS.find((c) => c.key === sort.key);
    return column ? sortByColumn(visibleCodes, column, sort.dir) : visibleCodes;
  }, [visibleCodes, sort]);
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
          <ReqopsLockup />
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
              {CODE_COLUMNS.map((column) => {
                const active = sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  >
                    <button
                      type="button"
                      className="sort-th"
                      data-active={active ? "true" : "false"}
                      onClick={() => setSort((current) => nextSort(current, column.key))}
                    >
                      {column.label}
                      <span className="sort-ind" aria-hidden="true">{active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sortedCodes.length === 0 && <tr><td colSpan={CODE_COLUMNS.length}>none yet</td></tr>}
            {sortedCodes.map((c) => (
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
                <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }} title={c.started_at || undefined}>{formatTimestamp(c.started_at)}</td>
                <td style={{ fontSize: 12.5, whiteSpace: "nowrap" }} title={c.submitted_at || undefined}>{formatTimestamp(c.submitted_at)}</td>
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

const DEFAULT_GATE = { requireLinkedin: true, requireUpwork: false, requireCv: false, requirePortfolio: false };

function gateSummary(a) {
  const parts = ["Name"];
  if (a.require_linkedin) parts.push("LinkedIn");
  if (a.require_upwork) parts.push("Upwork");
  if (a.require_cv) parts.push("CV");
  if (a.require_portfolio) parts.push("Portfolio");
  return parts.join(" · ");
}

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function AttachmentsEditor({ existing, pending, onAddPending, onRemovePending, onRemoveExisting }) {
  return (
    <div className="field">
      <label>Attachments for the candidate</label>
      <div style={{ display: "grid", gap: 6, marginTop: 6, fontSize: 14 }}>
        {existing.map((f) => (
          <div key={f.id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <a href={`/api/admin/attachments/${f.id}`}>{f.name}</a>
            <span style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>{fmtSize(f.size)}</span>
            <button type="button" className="btn-small" onClick={() => onRemoveExisting(f)}>Remove</button>
          </div>
        ))}
        {pending.map((f, i) => (
          <div key={`p${i}`} style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span>{f.name}</span>
            <span style={{ color: "var(--ink-faint)", fontSize: 12.5 }}>{fmtSize(f.size)} · uploads on save</span>
            <button type="button" className="btn-small" onClick={() => onRemovePending(i)}>Remove</button>
          </div>
        ))}
        <input
          type="file"
          multiple
          onChange={(e) => { onAddPending([...e.target.files]); e.target.value = ""; }}
        />
      </div>
      <p style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 8 }}>
        Candidates can download these alongside the brief once they start. Up to 50 MB per file.
      </p>
    </div>
  );
}

function GateFieldsEditor({ value, onChange }) {
  const row = (key, label) => (
    <label key={key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14 }}>
      <span style={{ minWidth: 170 }}>{label}</span>
      <select
        value={value[key] ? "yes" : "no"}
        onChange={(e) => onChange({ ...value, [key]: e.target.value === "yes" })}
        style={{ padding: "6px 10px" }}
      >
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  );
  return (
    <div className="field">
      <label>Candidate details to collect</label>
      <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
        {row("requireLinkedin", "LinkedIn profile URL")}
        {row("requireUpwork", "Upwork profile URL")}
        {row("requireCv", "CV / résumé upload")}
        {row("requirePortfolio", "Image portfolio upload")}
      </div>
      <p style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 8 }}>
        Full name is always required. Turn fields off when you only need a name.
      </p>
    </div>
  );
}

function AssessmentsPanel({ assessments, setError, refresh }) {
  const [editing, setEditing] = useState(null); // {id, title, brief} or null; id=null means "new"
  const [issuing, setIssuing] = useState(null);  // assessment id currently showing an issue-count input
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);

  function startNew() {
    setEditing({ id: null, title: "", brief: "", durationMinutes: 15, ...DEFAULT_GATE,
      allowCandidateUploads: false, attachments: [], pendingFiles: [], removedAttachments: [] });
  }
  function startEdit(a) {
    setEditing({
      id: a.id,
      title: a.title,
      brief: a.brief,
      durationMinutes: a.duration_minutes,
      requireLinkedin: !!a.require_linkedin,
      requireUpwork: !!a.require_upwork,
      requireCv: !!a.require_cv,
      requirePortfolio: !!a.require_portfolio,
      allowCandidateUploads: !!a.allow_candidate_uploads,
      attachments: a.attachments || [],
      pendingFiles: [],
      removedAttachments: [],
    });
  }
  function cancelEdit() { setEditing(null); }

  async function save() {
    if (!editing.title.trim()) { setError("Give the assessment a title."); return; }
    const duration = Number(editing.durationMinutes);
    if (!Number.isInteger(duration) || duration < 1) {
      setError("Duration must be at least 1 minute.");
      return;
    }
    setBusy(true);
    setError("");
    const body = {
      title: editing.title,
      brief: editing.brief,
      durationMinutes: duration,
      requireLinkedin: editing.requireLinkedin,
      requireUpwork: editing.requireUpwork,
      requireCv: editing.requireCv,
      requirePortfolio: editing.requirePortfolio,
      allowCandidateUploads: editing.allowCandidateUploads,
    };
    try {
      const { assessment } = editing.id
        ? await api.adminUpdateAssessment(editing.id, body)
        : await api.adminCreateAssessment(body);
      for (const id of editing.removedAttachments) await api.adminDeleteAttachment(id);
      if (editing.pendingFiles.length) await api.adminUploadAttachments(assessment.id, editing.pendingFiles);
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
              value={editing.durationMinutes}
              onChange={(e) => setEditing({ ...editing, durationMinutes: e.target.value })}
            />
          </div>
          <GateFieldsEditor
            value={{
              requireLinkedin: editing.requireLinkedin,
              requireUpwork: editing.requireUpwork,
              requireCv: editing.requireCv,
              requirePortfolio: editing.requirePortfolio,
            }}
            onChange={(gate) => setEditing({ ...editing, ...gate })}
          />
          <div className="field">
            <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14 }}>
              <span style={{ minWidth: 170 }}>Candidates can upload files</span>
              <select
                value={editing.allowCandidateUploads ? "yes" : "no"}
                onChange={(e) => setEditing({ ...editing, allowCandidateUploads: e.target.value === "yes" })}
                style={{ padding: "6px 10px" }}
              >
                <option value="yes">On</option>
                <option value="no">Off</option>
              </select>
            </label>
            <p style={{ fontSize: 12.5, color: "var(--ink-soft)", marginTop: 8 }}>
              When on, candidates get an upload box during the session to hand in their work for review.
            </p>
          </div>
          <AttachmentsEditor
            existing={editing.attachments}
            pending={editing.pendingFiles}
            onAddPending={(files) => setEditing((c) => ({ ...c, pendingFiles: [...c.pendingFiles, ...files] }))}
            onRemovePending={(i) => setEditing((c) => ({ ...c, pendingFiles: c.pendingFiles.filter((_, j) => j !== i) }))}
            onRemoveExisting={(f) => setEditing((c) => ({
              ...c,
              attachments: c.attachments.filter((x) => x.id !== f.id),
              removedAttachments: [...c.removedAttachments, f.id],
            }))}
          />
          <div className="field">
            <label id="a-brief-label" htmlFor="a-brief">Brief (shown to the candidate)</label>
            <Suspense fallback={<p>Loading brief editor…</p>}>
              <BriefEditor
                key={editing.id ?? "new"}
                value={editing.brief}
                onChange={(brief) => setEditing((current) => ({ ...current, brief }))}
              />
            </Suspense>
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
              {a.duration_minutes} min · {gateSummary(a)}
              {a.attachments?.length ? ` · ${a.attachments.length} attachment${a.attachments.length === 1 ? "" : "s"}` : ""}
              {a.allow_candidate_uploads ? " · uploads on" : ""} · {a.code_count} code{a.code_count === 1 ? "" : "s"} issued
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
