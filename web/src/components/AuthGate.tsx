import { useState, useEffect, type ReactNode } from "react";
import { getToken, setToken, clearToken } from "../api.ts";

export function AuthGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(!!getToken());
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(!!getToken());

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    setChecking(true);
    fetch("/api/artifacts?limit=1", {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.ok) {
          setAuthed(true);
        } else {
          clearToken();
          setAuthed(false);
        }
      })
      .catch(() => {
        clearToken();
        setAuthed(false);
      })
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return <div className="layout"><div className="loading">Authenticating...</div></div>;
  }

  if (authed) return <>{children}</>;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;

    setError("");
    setChecking(true);
    fetch("/api/artifacts?limit=1", {
      headers: { Authorization: `Bearer ${input.trim()}` },
    })
      .then((res) => {
        if (res.ok) {
          setToken(input.trim());
          setAuthed(true);
        } else {
          setError("Invalid token");
        }
      })
      .catch(() => setError("Connection failed"))
      .finally(() => setChecking(false));
  }

  return (
    <div className="layout" style={{ display: "flex", justifyContent: "center", paddingTop: 120 }}>
      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 360 }}>
        <h1 style={{ marginBottom: 24, textAlign: "center" }}>Espejo</h1>
        <input
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter access token"
          autoFocus
          style={{ marginBottom: 12 }}
        />
        {error && <div className="error-message" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn-primary" style={{ width: "100%" }} disabled={checking}>
          {checking ? "Checking..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
