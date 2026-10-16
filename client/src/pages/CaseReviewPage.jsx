import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api.js";

export default function CaseReviewPage() {
  const { code } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.adminSession(code).then(setData).catch((e) => setError(e.message));
  }, [code]);

  if (error) return <main className="page"><div className="error-box">{error}</div></main>;
  if (!data) return null;
  const { candidate, frames, audio = [], portfolio = [], uploads = [] } = data;
  const payload = data.payload || data.checkpoint;
  const draft = !data.payload && !!data.checkpoint;

  return (
    <main className="page wide review">
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/admin">Admin</Link><span className="sep">/</span>
        <span className="mono">{code}</span>
        <span className="spacer" />
        <a className="btn btn-line btn-sm" href={`/api/admin/sessions/${code}/zip`}>Download zip</a>
      </nav>
      <h2>Case <span className="mono">{code}</span></h2>
      {candidate && (
        <p>
          <b>Candidate:</b> {candidate.name}{candidate.email ? <> &lt;{candidate.email}&gt;</> : null}<br />
          {candidate.cv && (
            <><b>CV:</b> <a href={`/api/admin/sessions/${code}/cv`}>{candidate.cv}</a><br /></>
          )}
          {candidate.linkedin && (
            <><b>LinkedIn:</b> <a href={candidate.linkedin} target="_blank" rel="noreferrer">{candidate.linkedin}</a><br /></>
          )}
          {candidate.upwork && (
            <><b>Upwork:</b> <a href={candidate.upwork} target="_blank" rel="noreferrer">{candidate.upwork}</a><br /></>
          )}
        </p>
      )}
      {portfolio.length > 0 && (
        <>
          <h3>Portfolio ({portfolio.length})</h3>
          <div className="filmstrip">
            {portfolio.map((name, i) => (
              <figure key={name}>
                <a href={`/api/admin/sessions/${code}/portfolio/${name}`} target="_blank" rel="noreferrer">
                  <img src={`/api/admin/sessions/${code}/portfolio/${name}`} loading="lazy" alt={name} />
                </a>
                <figcaption>{(candidate?.portfolio && candidate.portfolio[i]) || name}</figcaption>
              </figure>
            ))}
          </div>
        </>
      )}
      {uploads.length > 0 && (
        <>
          <h3>Candidate uploads ({uploads.length})</h3>
          <ul>
            {uploads.map((u) => (
              <li key={u.file}>
                <a href={`/api/admin/sessions/${code}/uploads/${encodeURIComponent(u.file)}`}>{u.name}</a>
                {" "}<span className="help">
                  {Math.max(1, Math.round(u.size / 1024))} KB · {u.uploadedAt?.slice(0, 16).replace("T", " ")}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {payload ? (
        <>
          {draft && <p role="status"><b>Saved session in progress.</b> This is the latest recovered draft. The final result will appear after submission or the pause limit.</p>}
          <p>
            <b>{draft ? 'Last saved' : 'Received'}:</b>{' '}
            {draft ? new Date(payload.lastSavedAt).toLocaleString() : payload._receivedAt}<br />
            <b>Paused total:</b> {Math.round((payload.pausedTotal || 0) / 1000)}s
          </p>
          {(payload.log || []).some((ev) => ev.type === "voice") && (
            <>
              <h3>Spoken transcript</h3>
              <div className="transcript">
                {(payload.log || [])
                  .filter((ev) => ev.type === "voice")
                  .map((ev, i) => (
                    <span key={i}>
                      <span className="t">
                        {Math.floor(ev.t / 60)}:{String(ev.t % 60).padStart(2, "0")}{" "}
                      </span>
                      {ev.text}{" "}
                    </span>
                  ))}
              </div>
            </>
          )}
          {draft && payload.pendingTranscript && (
            <p><b>Last words awaiting recognition:</b> {payload.pendingTranscript}</p>
          )}
          <h3>Event log ({(payload.log || []).length})</h3>
          <div className="log-wrap">
          <table className="log-table">
            <thead><tr><th>t</th><th>type</th><th>detail</th></tr></thead>
            <tbody>
              {(payload.log || []).map((ev, i) => {
                const { t, type, ...rest } = ev;
                return (
                  <tr key={i}>
                    <td>{t}</td><td>{type}</td>
                    <td>{Object.keys(rest).length ? JSON.stringify(rest) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </>
      ) : (
        <p><i>No session has been saved yet.</i></p>
      )}
      <h3>Voice ({audio.length})</h3>
      <div className="audio-list">
        {audio.length === 0 && <p><i>No audio chunks yet.</i></p>}
        {audio.map((name) => (
          <div key={name} className="audio-row">
            <span>{name}</span>
            <audio controls preload="none" src={`/api/admin/sessions/${code}/audio/${name}`} />
          </div>
        ))}
      </div>
      <h3>Frames ({frames.length})</h3>
      <div className="filmstrip">
        {frames.map((name) => (
          <figure key={name}>
            <a href={`/api/admin/sessions/${code}/frames/${name}`} target="_blank" rel="noreferrer">
              <img src={`/api/admin/sessions/${code}/frames/${name}`} loading="lazy" alt={name} />
            </a>
            <figcaption>t={parseInt(name.match(/f_(\d+)/)?.[1] || 0, 10)}s</figcaption>
          </figure>
        ))}
      </div>
    </main>
  );
}
