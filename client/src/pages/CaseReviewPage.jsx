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
  const { payload, candidate, frames } = data;

  return (
    <main className="page wide review">
      <p>
        <Link to="/admin">← admin</Link>{" · "}
        <a href={`/api/admin/sessions/${code}/zip`}>download zip</a>
      </p>
      <h1 style={{ fontSize: 22, margin: "10px 0" }}>Case {code}</h1>
      {candidate && (
        <p>
          <b>Candidate:</b> {candidate.name} &lt;{candidate.email}&gt;<br />
          <b>Upwork:</b> <a href={candidate.upwork} target="_blank" rel="noreferrer">{candidate.upwork}</a>
        </p>
      )}
      {payload ? (
        <>
          <p>
            <b>Confidence:</b> {String(payload.confidence)}<br />
            <b>Received:</b> {payload._receivedAt}<br />
            <b>Paused total:</b> {Math.round((payload.pausedTotal || 0) / 1000)}s
          </p>
          {["1", "2", "3", "4"].map((z) => (
            <div key={z}>
              <h3>Zone {z}</h3>
              <pre>{payload.zones?.[z] || "(empty)"}</pre>
            </div>
          ))}
          <h3>Event log ({(payload.log || []).length})</h3>
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
        </>
      ) : (
        <p><i>No payload yet (in progress, or lost before submit).</i></p>
      )}
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
