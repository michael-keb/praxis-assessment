import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api.js";

/* Admin login only — candidates never sign in; they enter their details
   at the assessment gate. */
export default function AuthPage({ onAuthed }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [form, setForm] = useState({ email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { user } = await api.login(form);
      onAuthed(user);
      const next = searchParams.get("next");
      if (next && /^\/[^/]/.test(next) && !next.startsWith("//")) {
        window.location.href = next;
        return;
      }
      navigate(user.role === "admin" ? "/admin" : "/", { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <div className="card-col narrow">
        <div className="gate-mark">praxis</div>
        <h1>Admin log in</h1>
        <p className="lede">
          Taking an assessment? You don't need an account — open the link you
          were sent, or enter your code on the <a href="/">home page</a>.
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={form.email} onChange={set("email")} autoComplete="email" required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" value={form.password} onChange={set("password")}
              autoComplete="current-password" required />
          </div>
          <button className="btn-accent" disabled={busy}>{busy ? "Please wait…" : "Log in"}</button>
          {error && <div className="error-box">{error}</div>}
        </form>
      </div>
    </div>
  );
}
