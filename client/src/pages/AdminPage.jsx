import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CODE_COLUMNS, formatTimestamp, nextSort, sortByColumn } from "../admin-table-sort.js";
import { api } from "../api.js";
import { ReqopsLockup } from "../components/ReqopsMark.jsx";

const BriefEditor = lazy(() => import("../components/BriefEditor.jsx"));

export default function AdminPage({ user, onLogout }) {
  const [assessments, setAssessments] = useState([]);
  const [employers, setEmployers] = useState([]);
  const [codes, setCodes] = useState([]);
  const [error, setError] = useState("");
  const [filterId, setFilterId] = useState("all");
  const [sort, setSort] = useState({ key: null, dir: "asc" });

  const refresh = useCallback(() => {
    api.adminAssessments().then((d) => setAssessments(d.assessments)).catch((e) => setError(e.message));
    api.adminEmployers().then((d) => setEmployers(d.employers)).catch((e) => setError(e.message));
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
          <span className="who">{user.email}</span>
          <button className="btn btn-line btn-sm" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <main className="page wide">
        {error && <div className="error-box">{error}</div>}

        <EmployersPanel employers={employers} setError={setError} refresh={refresh} />

        <AssessmentsPanel assessments={assessments} employers={employers} setError={setError} refresh={refresh} />

        <section className="section">
        <div className="section-head"><h2>Issued codes</h2></div>
        <p className="help">
          {Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join(" · ") || "no codes yet"}
        </p>
        <div className="issue-row">
          <label htmlFor="code-filter">Show</label>
          <select id="code-filter" className="select" value={filterId} onChange={(e) => setFilterId(e.target.value)}>
            <option value="all">All assessments</option>
            {assessments.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        </div>
        <div className="table-wrap">
        <table className="table admin-table">
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
            {sortedCodes.length === 0 && <tr className="empty-row"><td colSpan={CODE_COLUMNS.length}>none yet</td></tr>}
            {sortedCodes.map((c) => (
              <tr key={c.code}>
                <td className="id">{c.code}</td>
                <td>{c.assessment_title || "—"}</td>
                <td><input className="link-input" readOnly aria-label={`Link for ${c.code}`} value={link(c.code)} onClick={(e) => e.target.select()} /></td>
                <td><span className={`badge ${STATUS_TONE[c.status] || ""}`}><span className="dot" />{c.status}</span></td>
                <td>
                  {c.candidate_name
                    ? c.candidate_linkedin
                      ? <a href={c.candidate_linkedin} target="_blank" rel="noreferrer">{c.candidate_name}</a>
                      : c.candidate_email
                        ? `${c.candidate_name} <${c.candidate_email}>`
                        : c.candidate_name
                    : "—"}
                </td>
                <td className="when nowrap" title={c.started_at || undefined}>{formatTimestamp(c.started_at)}</td>
                <td className="when nowrap" title={c.submitted_at || undefined}>{formatTimestamp(c.submitted_at)}</td>
                <td>{c.end_reason || "—"}</td>
                <td className="num">{c.frames}</td>
                <td className="num">{c.audio || 0}</td>
                <td className="nowrap">
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
        </div>
        </section>
      </main>
    </>
  );
}

/* Status chips are neutral; the dot carries the tone. */
const STATUS_TONE = { active: "info", submitted: "ok", void: "" };

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
      <div className="file-list">
        {existing.map((f) => (
          <div key={f.id} className="file-row">
            <a href={`/api/admin/attachments/${f.id}`}>{f.name}</a>
            <span className="size">{fmtSize(f.size)}</span>
            <button type="button" className="btn btn-line btn-sm" onClick={() => onRemoveExisting(f)}>Remove</button>
          </div>
        ))}
        {pending.map((f, i) => (
          <div key={`p${i}`} className="file-row">
            <span>{f.name}</span>
            <span className="size">{fmtSize(f.size)} · uploads on save</span>
            <button type="button" className="btn btn-line btn-sm" onClick={() => onRemovePending(i)}>Remove</button>
          </div>
        ))}
        <input
          type="file"
          multiple
          onChange={(e) => { onAddPending([...e.target.files]); e.target.value = ""; }}
        />
      </div>
      <p className="help">
        Candidates can download these alongside the brief once they start. Up to 50 MB per file.
      </p>
    </div>
  );
}

function JobDescriptionEditor({ id, url, existingName, pending, onUrl, onFile, onRemoveExisting }) {
  return (
    <div className="field">
      <label htmlFor="a-jd-url">Job description</label>
      <input
        id="a-jd-url"
        className="input"
        type="url"
        value={url}
        onChange={(e) => onUrl(e.target.value)}
        placeholder="https://example.com/careers/role (optional)"
        spellCheck="false"
      />
      <div className="file-list">
        {existingName && !pending && (
          <div className="file-row">
            <a href={`/api/admin/assessments/${id}/job-description`}>{existingName}</a>
            <button type="button" className="btn btn-line btn-sm" onClick={onRemoveExisting}>Remove</button>
          </div>
        )}
        {pending && (
          <div className="file-row">
            <span>{pending.name}</span>
            <span className="size">{fmtSize(pending.size)} · uploads on save</span>
            <button type="button" className="btn btn-line btn-sm" onClick={() => onFile(null)}>Remove</button>
          </div>
        )}
        <input
          type="file"
          accept=".pdf,.doc,.docx,.rtf,.txt,.md"
          aria-label="Job description file"
          onChange={(e) => { onFile(e.target.files?.[0] || null); e.target.value = ""; }}
        />
      </div>
      <p className="help">
        Add a link, a file (PDF, Word, RTF, Markdown or text, up to 10 MB), or both. Candidates can open it before
        they start and during the assessment. A new file replaces the old one.
      </p>
    </div>
  );
}

const logoUrl = (file) => `/api/assessment/brand/logos/${file}`;

function EmployersPanel({ employers, setError, refresh }) {
  const [editing, setEditing] = useState(null); // {id, name, brandColor, logoFile, pendingLogo, removeLogo}; id=null means "new"
  const [busy, setBusy] = useState(false);
  const [previewLogo, setPreviewLogo] = useState(null);

  useEffect(() => {
    if (editing?.pendingLogo) {
      const url = URL.createObjectURL(editing.pendingLogo);
      setPreviewLogo(url);
      return () => URL.revokeObjectURL(url);
    }
    setPreviewLogo(editing?.logoFile && !editing.removeLogo ? logoUrl(editing.logoFile) : null);
  }, [editing?.pendingLogo, editing?.logoFile, editing?.removeLogo]);

  function startNew() {
    setEditing({ id: null, name: "", brandColor: "", logoFile: null, pendingLogo: null, removeLogo: false });
  }
  function startEdit(emp) {
    setEditing({ id: emp.id, name: emp.name, brandColor: emp.brand_color || "", logoFile: emp.logo_file, pendingLogo: null, removeLogo: false });
  }

  async function save() {
    if (!editing.name.trim()) { setError("Give the employer a name."); return; }
    setBusy(true);
    setError("");
    const body = { name: editing.name, brandColor: editing.brandColor.trim() };
    try {
      const { employer } = editing.id
        ? await api.adminUpdateEmployer(editing.id, body)
        : await api.adminCreateEmployer(body);
      if (editing.pendingLogo) await api.adminUploadEmployerLogo(employer.id, editing.pendingLogo);
      else if (editing.removeLogo) await api.adminDeleteEmployerLogo(employer.id);
      setEditing(null);
      refresh();
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  async function remove(emp) {
    if (!window.confirm(`Delete employer "${emp.name}"?`)) return;
    try { await api.adminDeleteEmployer(emp.id); refresh(); }
    catch (e) { setError(e.message); }
  }

  const validColor = /^#[0-9a-f]{6}$/i.test(editing?.brandColor || "");

  return (
    <section className="section">
      <div className="section-head">
        <h2>Employers</h2>
        <div className="spacer" />
        {!editing && <button className="btn btn-line" onClick={startNew}>New employer</button>}
      </div>
      <p className="help">
        Brand an assessment under the employer you are hiring for. Candidates see the employer's logo and colour;
        assessments without an employer stay ReqOps-branded.
      </p>

      {editing && (
        <div className="card editor-card">
          <div className="field">
            <label htmlFor="e-name">Employer name</label>
            <input id="e-name" className="input" value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Nfiny" />
          </div>
          <div className="field">
            <label htmlFor="e-color">Brand colour</label>
            <div className="file-row">
              <input type="color" aria-label="Pick brand colour" value={validColor ? editing.brandColor : "#888888"}
                onChange={(e) => setEditing({ ...editing, brandColor: e.target.value })}
                style={{ width: 44, height: 36, padding: 2, background: "none", border: 0 }} />
              <input id="e-color" className="input" value={editing.brandColor}
                onChange={(e) => setEditing({ ...editing, brandColor: e.target.value })}
                placeholder="#1a73e8 (optional)" spellCheck="false" style={{ maxWidth: 180, fontFamily: "var(--font-mono)" }} />
              {editing.brandColor && (
                <button type="button" className="btn btn-line btn-sm" onClick={() => setEditing({ ...editing, brandColor: "" })}>Clear</button>
              )}
            </div>
            <p className="help">Shown as a stripe along the top of the candidate's screens.</p>
          </div>
          <div className="field">
            <label htmlFor="e-logo">Logo</label>
            <div className="file-list">
              {previewLogo && (
                <div className="file-row">
                  <img className="logo-plate" src={previewLogo} alt="" style={{ height: 36 }} />
                  <button type="button" className="btn btn-line btn-sm"
                    onClick={() => setEditing({ ...editing, pendingLogo: null, removeLogo: true })}>Remove</button>
                </div>
              )}
              <input id="e-logo" type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setEditing((c) => ({ ...c, pendingLogo: f, removeLogo: false }));
                  e.target.value = "";
                }} />
            </div>
            <p className="help">
              PNG, JPG or WebP up to 2 MB. A wide logo works best. Without a logo, candidates see the employer name.
            </p>
          </div>
          <div className="actions">
            <button className="btn btn-primary" disabled={busy} aria-busy={busy || undefined} onClick={save}>
              {busy ? "Saving…" : "Save employer"}
            </button>
            <button className="btn btn-line" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      {employers.length === 0 && !editing && (
        <p className="help">No employers yet. Every assessment is ReqOps-branded.</p>
      )}
      {employers.map((emp) => (
        <div key={emp.id} className="card admin-card" style={emp.brand_color ? { borderLeft: `4px solid ${emp.brand_color}` } : undefined}>
          <div className="head">
            {emp.logo_file && <img className="logo-plate" src={logoUrl(emp.logo_file)} alt="" style={{ height: 24, maxWidth: 140 }} />}
            <span className="title">{emp.name}</span>
            <span className="meta">
              {emp.brand_color || "no colour"} · {emp.assessment_count} assessment{emp.assessment_count === 1 ? "" : "s"}
            </span>
            <div className="actions">
              <button className="btn btn-line btn-sm" onClick={() => startEdit(emp)}>Edit</button>
              {emp.assessment_count === 0 && <button className="btn btn-danger btn-sm" onClick={() => remove(emp)}>Delete</button>}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}

function GateFieldsEditor({ value, onChange }) {
  const row = (key, label) => (
    <label key={key} className="inline">
      <span>{label}</span>
      <select
        className="select"
        value={value[key] ? "yes" : "no"}
        onChange={(e) => onChange({ ...value, [key]: e.target.value === "yes" })}
      >
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  );
  return (
    <div className="field">
      <label>Candidate details to collect</label>
      <div className="file-list">
        {row("requireLinkedin", "LinkedIn profile URL")}
        {row("requireUpwork", "Upwork profile URL")}
        {row("requireCv", "CV / résumé upload")}
        {row("requirePortfolio", "Image portfolio upload")}
      </div>
      <p className="help">
        Full name is always required. Turn fields off when you only need a name.
      </p>
    </div>
  );
}

function AssessmentsPanel({ assessments, employers, setError, refresh }) {
  const [editing, setEditing] = useState(null); // {id, title, brief} or null; id=null means "new"
  const [issuing, setIssuing] = useState(null);  // assessment id currently showing an issue-count input
  const [count, setCount] = useState(5);
  const [busy, setBusy] = useState(false);

  function startNew() {
    setEditing({ id: null, title: "", brief: "", durationMinutes: 15, ...DEFAULT_GATE,
      allowCandidateUploads: false, attachments: [], pendingFiles: [], removedAttachments: [],
      employerId: "", jobDescriptionUrl: "", jobDescriptionName: null, pendingJdFile: null, removeJd: false });
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
      employerId: a.employer_id ? String(a.employer_id) : "",
      jobDescriptionUrl: a.job_description_url || "",
      jobDescriptionName: a.job_description_file ? a.job_description_name : null,
      pendingJdFile: null,
      removeJd: false,
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
      employerId: editing.employerId ? Number(editing.employerId) : null,
      jobDescriptionUrl: editing.jobDescriptionUrl.trim(),
    };
    try {
      const { assessment } = editing.id
        ? await api.adminUpdateAssessment(editing.id, body)
        : await api.adminCreateAssessment(body);
      for (const id of editing.removedAttachments) await api.adminDeleteAttachment(id);
      if (editing.pendingFiles.length) await api.adminUploadAttachments(assessment.id, editing.pendingFiles);
      if (editing.pendingJdFile) await api.adminUploadJobDescription(assessment.id, editing.pendingJdFile);
      else if (editing.removeJd) await api.adminDeleteJobDescription(assessment.id);
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
      <div className="section-head">
        <h2>Assessments</h2>
        <div className="spacer" />
        {!editing && (
          <button className="btn btn-primary" onClick={startNew}>
            New assessment
          </button>
        )}
      </div>
      <p className="help">
        Write up the brief for a candidate, save it, then issue codes under it — each code hands that
        candidate this exact brief.
      </p>

      {editing && (
        <div className="card editor-card">
          <div className="field">
            <label htmlFor="a-title">Title</label>
            <input
              id="a-title"
              className="input"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              placeholder="e.g. Senior React — build task"
            />
          </div>
          <div className="field">
            <label className="inline">
              <span>Branded as</span>
              <select
                className="select"
                value={editing.employerId}
                onChange={(e) => setEditing({ ...editing, employerId: e.target.value })}
              >
                <option value="">ReqOps (no employer)</option>
                {employers.map((emp) => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
              </select>
            </label>
            <p className="help">
              Candidates see this employer's logo and colour on every screen. Add employers under Employers above.
            </p>
          </div>
          <JobDescriptionEditor
            id={editing.id}
            url={editing.jobDescriptionUrl}
            existingName={editing.removeJd ? null : editing.jobDescriptionName}
            pending={editing.pendingJdFile}
            onUrl={(jobDescriptionUrl) => setEditing((c) => ({ ...c, jobDescriptionUrl }))}
            onFile={(pendingJdFile) => setEditing((c) => ({ ...c, pendingJdFile }))}
            onRemoveExisting={() => setEditing((c) => ({ ...c, removeJd: true }))}
          />
          <div className="field" style={{ maxWidth: 180 }}>
            <label htmlFor="a-duration">Duration (minutes)</label>
            <input
              id="a-duration"
              className="input"
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
            <label className="inline">
              <span>Candidates can upload files</span>
              <select
                className="select"
                value={editing.allowCandidateUploads ? "yes" : "no"}
                onChange={(e) => setEditing({ ...editing, allowCandidateUploads: e.target.value === "yes" })}
              >
                <option value="yes">On</option>
                <option value="no">Off</option>
              </select>
            </label>
            <p className="help">
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
          <div className="actions">
            <button className="btn btn-primary" disabled={busy} aria-busy={busy || undefined} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-line" onClick={cancelEdit}>Cancel</button>
          </div>
        </div>
      )}

      {assessments.length === 0 && !editing && (
        <p className="help">No assessments yet — create one to start issuing codes.</p>
      )}

      {assessments.map((a) => (
        <div key={a.id} className="card admin-card">
          <div className="head">
            <span className="title">{a.title}</span>
            <span className="meta">
              {a.employer_name || "ReqOps"} · {a.duration_minutes} min · {gateSummary(a)}
              {a.job_description_url || a.job_description_file ? " · job description" : ""}
              {a.attachments?.length ? ` · ${a.attachments.length} attachment${a.attachments.length === 1 ? "" : "s"}` : ""}
              {a.allow_candidate_uploads ? " · uploads on" : ""} · {a.code_count} code{a.code_count === 1 ? "" : "s"} issued
              · updated {a.updated_at?.slice(0, 10)}
            </span>
            <div className="actions">
              <button className="btn btn-line btn-sm" onClick={() => startEdit(a)}>Edit</button>
              <button className="btn btn-line btn-sm" onClick={() => setIssuing(issuing === a.id ? null : a.id)}>Issue codes</button>
              {a.code_count === 0 && <button className="btn btn-danger btn-sm" onClick={() => remove(a)}>Delete</button>}
            </div>
          </div>
          {issuing === a.id && (
            <div className="issue-row">
              <input className="input" type="number" min="1" max="200" aria-label="Number of codes" value={count} onChange={(e) => setCount(e.target.value)} />
              <button className="btn btn-primary" onClick={() => issue(a)}>
                Issue
              </button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
